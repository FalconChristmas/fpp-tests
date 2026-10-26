import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { settleAfterApply } from './pipewire-conf';
import { cleanupPipeWire, fakeSoundCards, hwParams, readFile, sinkNode, standInAplay, standInPwDump } from './pw-helpers';
import { clearSystemctlCalls, realSystemctl, standInSystemctl, systemctlCalls } from './pw-systemctl';
import { stopPipeWire } from './pw-live';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: ac141d68a ("one way to restart the audio stack, and skip
// applies that change nothing").  Applying the audio output groups
// restarted the PipeWire daemons (and, through some paths, not fppd, which
// a daemon restart leaves silent) every time.  Worse, the generated config
// wasn't deterministic: whether to declare FPP's own ALSA adapter for a card
// was decided from whether that adapter's node was in the graph -- which it
// is, because FPP declared it -- so the next apply dropped it, and the
// member played to a node that no longer existed.  The adapter is now
// decided from 95-fpp-alsa-sink.conf, an unchanged config is not applied,
// and a changed one restarts the stack and fppd once.  The card is a fake
// (/proc/asound, aplay); the graph a stand-in pw-dump; systemctl
// pw-systemctl.ts's stand-in, whose restarts are recorded.

test.skip(!container, 'stubs a sound card and systemctl inside the run-web.sh container');

const CONF = '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
  standInSystemctl();
});
test.afterEach(async ({ request }) => {
  realSystemctl();
  stopPipeWire();
  cleanupPipeWire();
  restoreSettings();
  await settleAfterApply(request);
});

async function uptime(request: APIRequestContext): Promise<number> {
  try {
    const r = await request.get('/api/fppd/status');
    return r.ok() ? ((await r.json()).uptimeTotalSeconds ?? -1) : -1;
  } catch {
    return -1;
  }
}

async function apply(request: APIRequestContext, groups: unknown[]) {
  const save = await request.post('/api/pipewire/audio/groups', { data: { groups } });
  expect(save.ok(), await save.text()).toBe(true);
  const r = await request.post('/api/pipewire/audio/groups/apply', { timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  await settleAfterApply(request);
}

const restarts = () => systemctlCalls().filter((c) => /^restart fpp-(pipewire|wireplumber|pipewire-pulse)\.service$/.test(c));

test('applying the output groups again with nothing changed keeps the config and restarts nothing', async ({ request }) => {
  test.setTimeout(240_000);
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
  // No WirePlumber sink for the card: FPP declares its own ALSA adapter.
  standInPwDump([]);
  const groups = [{ id: 1, name: 'Main', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2 }] }];
  await apply(request, groups);
  const first = readFile(CONF);
  // The control: the adapter was declared, and the first apply restarted the stack.
  expect(first).toContain('node.name = "fpp_alsa_x"');
  expect(restarts().length).toBeGreaterThan(0);

  // Now the adapter it declared is in the graph, as it would be.
  standInPwDump([sinkNode(50, 'fpp_alsa_x', { 'alsa.card': 0 })]);
  clearSystemctlCalls();
  await new Promise((r) => setTimeout(r, 1500));
  const up = await uptime(request);
  await apply(request, groups);
  expect(readFile(CONF), 'the second apply generated a different config').toBe(first);
  expect(restarts(), 'an apply that changed nothing restarted the stack').toEqual([]);
  expect(await uptime(request), 'an apply that changed nothing restarted fppd').toBeGreaterThanOrEqual(up);

  // A change is applied: the stack restarts once, and fppd with it.
  clearSystemctlCalls();
  await new Promise((r) => setTimeout(r, 3000));
  const up3 = await uptime(request);
  await apply(request, [{ ...groups[0], channels: 2, members: [{ cardId: 'X', channels: 2, delayMs: 10 }] }]);
  expect(restarts()).toEqual(['restart fpp-pipewire.service', 'restart fpp-wireplumber.service', 'restart fpp-pipewire-pulse.service']);
  await expect.poll(() => uptime(request), { timeout: 30_000, message: 'fppd was not restarted with the stack' }).toBeLessThan(up3);
});
