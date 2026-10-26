import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { filterParams, stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, props } from './pw-load';
import { settleAfterApply } from './pipewire-conf';
import { CONFIG, cleanupPipeWire, fakeSoundCards, hwParams, readFile, standInAplay, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Two properties of an output group member's filter chain in the generated
// PipeWire config (97-fpp-audio-groups.conf): how long a delay it may have,
// and whether its links let the graph go idle.  The card is a fake under
// /proc/asound with a stand-in aplay; the conf is then loaded by a real
// PipeWire (pw-load.ts), FPP's own ALSA adapter as a null sink, and read
// back with the real pw-dump.

test.skip(!container, 'stubs a sound card and reads the generated config inside the run-web.sh container');

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
});
test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
  restoreSettings();
});

function group(delayMs: number) {
  return { id: 1, name: 'Delayed', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2, delayMs }] };
}

async function apply(request: APIRequestContext) {
  const r = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
  return readFile(CONF);
}

test('a member delay over the old 2 s limit is kept by the page and run by PipeWire', async ({ page, request }) => {
  // Regression: 651146993.  The groups page clamped a member's delay to
  // 2000 ms (the input's max and UpdateMemberDelay()), so a speaker further
  // than about 680 m of sound away could not be lined up.  It is 5000 ms now.
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, { groups: [group(0)] });
  await page.goto('/pipewire-audio.php');
  const delay = page.locator('input[onchange^="UpdateMemberDelay(0,0"]');
  await expect(delay).toBeVisible({ timeout: 15_000 });
  await delay.fill('3500');
  await delay.dispatchEvent('change');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/pipewire/audio/groups') && r.request().method() === 'POST');
  await page.evaluate(() => (window as any).SaveGroups());
  expect((await saved).ok()).toBe(true);
  const stored = JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups.json`));
  expect(stored.groups[0].members[0].delayMs, 'the page cut the delay down').toBe(3500);

  // The receiving end: PipeWire's filter chain runs the delay.
  const conf = await apply(request);
  expect(conf).toContain('"Delay (s)" = 3.5');
  loadGeneratedConf([], ['fpp_group_delayed', 'fpp_fx_g1_x'], { nullAdapters: true });
  expect(filterParams('fpp_fx_g1_x')).toMatchObject({ 'delay_l:Delay (s)': 3.5, 'delay_r:Delay (s)': 3.5 });
});

for (const passive of ['1', '0']) {
  test(`PipeWirePassiveSinks ${passive === '1' ? 'on makes the filter chain playback passive' : 'off leaves the filter chain playback active'}`, async ({ request }) => {
    // Feature: 00eb6eebf ("let the PipeWire graph suspend the sound card
    // when idle").  No link of the chain combine-stream -> filter-chain ->
    // ALSA sink was passive, so the card was clocked and the chain run every
    // quantum with nothing playing.  The filter chain's playback stream and
    // the combine-stream's output streams are node.passive now, unless the
    // setting turns it off.
    setSettingInFile('PipeWirePassiveSinks', passive);
    const save = await request.post('/api/pipewire/audio/groups', { data: { groups: [group(100)] } });
    expect(save.ok(), await save.text()).toBe(true);
    const conf = await apply(request);
    const marked = (conf.match(/^\s*node\.passive = true$/mg) ?? []).length;
    if (passive === '1') expect(marked, conf).toBeGreaterThanOrEqual(2);
    else expect(marked, conf).toBe(0);

    // The receiving end: the filter chain's playback stream and the
    // combine-stream's output streams, as PipeWire made them.
    loadGeneratedConf([], ['fpp_group_delayed', 'fpp_fx_g1_x'], { nullAdapters: true });
    await expect.poll(() => [...graph().nodes.keys()].filter((n) => n.startsWith('output.fpp_group_delayed_')).length,
      { timeout: 10_000 }).toBeGreaterThan(0);
    const g = graph();
    const streams = [...g.nodes.keys()].filter((n) => n === 'fpp_fx_g1_x_out' || n.startsWith('output.fpp_group_delayed_'));
    expect(streams, describe(g)).toContain('fpp_fx_g1_x_out');
    const marks = Object.fromEntries(streams.map((n) => [n, String(props(g, n)['node.passive'] ?? 'unset')]));
    // The filter chain's playback stream is passive only when the setting says.
    expect(marks['fpp_fx_g1_x_out'], JSON.stringify(marks)).toBe(passive === '1' ? 'true' : 'unset');
    // combine-stream makes its output streams passive by default, so the
    // conf's own stream.props line changes nothing there: they are passive
    // either way.
    for (const n of streams.filter((m) => m.startsWith('output.'))) {
      expect(marks[n], JSON.stringify(marks)).toBe('true');
    }
  });
}
