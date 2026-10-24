import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import {
  CONFIG, cleanupPipeWire, commandLog, fakeSoundCards, sinkNode, standInCommand, standInPwDump, writeFile,
} from './pw-helpers';
import { listen, pw, sinkVolume, startPipeWire, stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, reaches, standInNode } from './pw-load';

// What Save & Apply of PipeWire audio output groups does besides writing the
// config: which sink fppd is pointed at (PipeWireSinkName), the volumes and
// mixer levels it puts back once the stack is up, and what it does when fppd
// does not answer.  Volumes are set on a real private PipeWire (pw-live.ts)
// and read back from it; the conf the PHP wrote is loaded by it to check that
// the sink fppd is pointed at exists.  amixer is a stand-in that logs its
// calls: the image has no alsa-utils and no card for it to drive.

test.skip(!container, 'stubs PipeWire tools and reads the settings file inside the run-web.sh container');

// Each Apply restarts fppd and waits for it to come back.
test.describe.configure({ timeout: 240_000 });

const SETTINGS = '/home/fpp/media/settings';

function sinkName(): string {
  const line = inPlayer('sh', '-c', `grep '^PipeWireSinkName ' ${SETTINGS} || true`).trim();
  return line.replace(/^PipeWireSinkName\s*=\s*"?([^"]*)"?$/, '$1');
}

test.beforeEach(() => {
  // A value no apply writes, so a stale one cannot pass for the answer.
  inPlayer('sh', '-c', `sed -i '/^PipeWireSinkName /d' ${SETTINGS} && echo 'PipeWireSinkName = "fpp-tests-unset"' >> ${SETTINGS}`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `sed -i '/^PipeWireSinkName /d' ${SETTINGS}`);
  stopPipeWire();
  cleanupPipeWire();
});

async function apply(request: APIRequestContext, groups: unknown[], timeout = 120_000) {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, { groups });
  const r = await request.post('/api/pipewire/audio/groups/apply', { timeout });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}

test('the A/V settings page has no Primary Audio Output picker any more', async ({ request }) => {
  // Regression: 5d7c9dd23. A "Primary Audio Output" select on the A/V page
  // (and its /api/pipewire/audio/primary-output endpoint) set
  // PipeWireSinkName by hand, and the next Save & Apply of the output groups
  // overwrote it; the group setup owns it now.
  const page = await request.get('/settings-av.php');
  expect(page.ok()).toBe(true);
  const html = await page.text();
  expect(html, 'the page did not render its PipeWire section').toContain('pipeWireSection');
  expect(html).not.toContain('PipeWirePrimaryOutput');
  const r = await request.post('/api/pipewire/audio/primary-output', { data: { sinkName: 'fpp_group_x' } });
  expect(r.status()).toBe(404);
  expect(sinkName()).toBe('fpp-tests-unset');
});

test('with an input group taking the media stream, fppd is pointed at the input group', async ({ request }) => {
  // Regression: 009a5723d. Applying the output groups always set
  // PipeWireSinkName to the first output group, so with an input group
  // (mix bus) configured, fppd's stream skipped the bus and went straight to
  // the output: the bus's other members and its routing were bypassed.
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Show Bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }],
  });
  // The member's card has a (WirePlumber) sink, so the output group is built.
  fakeSoundCards([{ id: 'X' }]);
  standInPwDump([sinkNode(40, 'alsa_output.x', { 'alsa.card': 0 })]);
  const body = await apply(request, [{ id: 1, name: 'Out', enabled: true, channels: 2,
    members: [{ cardId: 'X', channels: 2 }] }]);
  await settleAfterApply(request);
  expect(sinkName()).toBe('fpp_input_show_bus');
  expect(body.routedViaInputGroup, JSON.stringify(body)).toBe(true);

  // In a real PipeWire with both confs: the sink fppd is pointed at exists
  // and what plays into it comes out of the output group's card.
  loadGeneratedConf([standInNode('alsa_output.x')], ['fpp_input_show_bus', 'fpp_group_out']);
  await expect.poll(() => reaches(graph(), 'fpp_input_show_bus', 'alsa_output.x'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
  stopPipeWire();

  // The control: with no input groups the first enabled output group with
  // members is the target.
  inPlayer('rm', '-f', `${CONFIG}/pipewire-input-groups.json`, '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf');
  await apply(request, [
    { id: 1, name: 'Off', enabled: false, channels: 2, members: [{ cardId: 'X', channels: 2 }] },
    { id: 2, name: 'Empty', enabled: true, channels: 2, members: [] },
    { id: 3, name: 'Out', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2 }] },
  ]);
  await settleAfterApply(request);
  expect(sinkName()).toBe('fpp_group_out');
});

test("a member on a WirePlumber sink has that sink put back to full volume", async ({ request }) => {
  // Regression: 44dc2e937. WirePlumber brings an HDMI sink up at about 40%,
  // and nothing raised it, so a group member on one played quietly.  After
  // the stack restarts, each member's WirePlumber sink is set to 100%;
  // FPP's own nodes start at full volume and are left alone.
  // A real PipeWire throughout: the PHP's pw-dump finds the two sinks in it,
  // and its pactl sets their volumes there.
  const hdmi = 'alsa_output.platform-hdmi.hdmi-stereo';
  // (Whether FPP's own fpp_alsa_x is left alone cannot be seen here: fppd,
  // restarted by the Apply, puts its master volume on every fpp_alsa_* sink.)
  startPipeWire({ objects: [standInNode(hdmi), standInNode('fpp_alsa_x')] });
  pw(`pactl set-sink-volume ${hdmi} 40%`);
  listen(hdmi);
  expect(sinkVolume(hdmi)).toBe(40);
  await apply(request, [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [
    { cardId: 'vc4hdmi0', channels: 2, nodeTarget: hdmi },
    { cardId: 'X', channels: 2, nodeTarget: 'fpp_alsa_x' },
  ] }]);
  await settleAfterApply(request);
  expect(sinkVolume(hdmi), 'the WirePlumber sink was left at 40%').toBe(100);
});

test("a member card's playback mixers are set to full after the apply", async ({ request }) => {
  // Regression: 80f681e2a. WirePlumber restores saved ALSA mixer state for
  // the cards it sees, which can leave a card's hardware mixer at zero under
  // FPP's own sinks: a silent output after Apply.  Every playback control of
  // each member card is now set to 100%; capture and mic controls are not.
  fakeSoundCards([{ id: 'Other' }, { id: 'X' }]);
  standInCommand('amixer', [
    'case "$*" in *scontrols*) printf "Simple mixer control \'PCM\',0\\nSimple mixer control \'Mic\',0\\n' +
      'Simple mixer control \'Capture\',0\\n" ;; esac',
    'exit 0',
  ].join('\n') + '\n');
  await apply(request, [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2 }] }]);
  await settleAfterApply(request);
  // amixer's own form: -c <card number> sset <simple control> <volume>.
  const sets = commandLog('amixer').filter((l) => l.includes('sset'));
  expect(sets).toEqual(['-c 1 sset PCM 100%']);
});

test('Apply returns while fppd is not answering', async ({ request }) => {
  // Regression: 0e29c5006. Before stopping playback, both Applies asked
  // fppd for its status with no timeout of their own; with fppd wedged
  // (stuck tearing down a GStreamer pipeline) the request hung for PHP's
  // whole default_socket_timeout and the page never came back.  The status
  // read now gives up after 3 s.
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }],
  });
  const fppd = inPlayer('pgrep', '-o', '-x', 'fppd').trim();
  expect(fppd).not.toBe('');
  inPlayer('kill', '-STOP', fppd);
  try {
    for (const url of ['/api/pipewire/audio/groups/apply', '/api/pipewire/audio/input-groups/apply']) {
      if (url.includes('/groups/')) {
        writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
          groups: [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2 }] }],
        });
      }
      const started = Date.now();
      const r = await request.post(url, { timeout: 90_000 });
      expect(r.ok(), await r.text()).toBe(true);
      expect(Date.now() - started, `${url} took too long`).toBeLessThan(90_000);
    }
  } finally {
    inPlayer('kill', '-CONT', fppd);
  }
  await settleAfterApply(request);
  // fppd's side: once it runs again it answers, and it was not left wedged.
  const st = await request.get('/api/fppd/status');
  expect(st.ok()).toBe(true);
  expect((await st.json()).fppd).toBe('running');
});
