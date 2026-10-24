import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { CONFIG, cleanupPipeWire, commandLog, fakeSoundCards, hwParams, readFile, standInAplay, standInAt, writeFile } from './pw-helpers';
import { filterParams, stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, reaches } from './pw-load';

// Changing the Media Backend setting through the settings API: the PHP
// writes the PipeWire config for the new mode itself and leaves restarting
// the stack to `fppinit setupAudio`, run in the background.  fppinit and
// systemctl are stand-ins here (the PHP runs both by full path), so what is
// checked is what the PHP wrote and ran before it answered -- and, for Simple
// mode, that a real PipeWire (pw-load.ts) loading the conf it wrote builds the
// sink fppd is pointed at.  The card's ALSA adapter is loaded as a null sink
// (no card here), so the card side itself is not checked.

test.skip(!container, 'stubs fppinit and systemctl inside the run-web.sh container');

const SETTINGS = '/home/fpp/media/settings';
const KEYS = /^(MediaBackend|AudioOutput|PipeWireSinkName(_\d)?) /;
let saved: string[] = [];

function setting(key: string): string | undefined {
  const line = readFile(SETTINGS).split('\n').find((l) => l.startsWith(`${key} `));
  return line === undefined ? undefined : line.replace(/^\S+\s*=\s*"?([^"]*)"?$/, '$1');
}

function writeSettings(values: Record<string, string>) {
  const keep = readFile(SETTINGS).split('\n').filter((l) => l && !KEYS.test(l));
  writeFile(SETTINGS, [...keep, ...Object.entries(values).map(([k, v]) => `${k} = "${v}"`)].join('\n') + '\n');
}

test.beforeEach(() => {
  saved = readFile(SETTINGS).split('\n').filter((l) => KEYS.test(l));
  // As slow as the real one, so its background run is still going when the
  // settings call answers.
  standInAt('/opt/fpp/src/fppinit', 'sleep 3\nexit 0\n');
});

test.afterEach(async ({ request }) => {
  // Back to the mode the player was in, fppd included, while fppinit is
  // still the stand-in; then the settings lines as they were.
  inPlayer('rm', '-f', `${CONFIG}/pipewire-audio-groups.json`, `${CONFIG}/pipewire-input-groups.json`);
  const backend = saved.find((l) => l.startsWith('MediaBackend '));
  await request.put('/api/settings/MediaBackend', {
    data: backend ? backend.replace(/^\S+\s*=\s*"?([^"]*)"?$/, '$1') : 'pipewire-simple', timeout: 120_000 });
  const keep = readFile(SETTINGS).split('\n').filter((l) => l && !KEYS.test(l));
  writeFile(SETTINGS, [...keep, ...saved].join('\n') + '\n');
  inPlayer('rm', '-f', `${CONFIG}/pipewire-audio-groups-simple.json`, `${CONFIG}/pipewire-video-groups-simple.json`);
  stopPipeWire();
  cleanupPipeWire();
});

async function switchBackend(request: APIRequestContext, to: string) {
  const started = Date.now();
  const r = await request.put('/api/settings/MediaBackend', { data: to, timeout: 120_000 });
  expect(r.ok(), await r.text()).toBe(true);
  return Date.now() - started;
}

test('switching to Simple mode points fppd at the simple group before PipeWire restarts', async ({ request }) => {
  // Regression: 7e12854ab. The switch writes the simple group's config but
  // leaves the restart to the background; it returned before setting
  // PipeWireSinkName, so fppd kept the advanced mode's sink (a mix bus that
  // no longer exists) and the next start played into nothing.
  // AudioOutput as a card index, which every version resolves to its ID.
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
  writeSettings({ MediaBackend: 'pipewire', AudioOutput: '0', PipeWireSinkName: 'fpp_input_mix_bus_1',
    PipeWireSinkName_2: 'fpp_input_mix_bus_2' });
  await switchBackend(request, 'pipewire-simple');
  expect(setting('PipeWireSinkName')).toBe('fpp_group_default');
  expect(setting('PipeWireSinkName_2'), 'an advanced-mode slot sink was left behind').toBe('');

  // The sink it names is the one a real PipeWire builds from the simple conf.
  loadGeneratedConf([], ['fpp_group_default', 'fpp_alsa_x'], { nullAdapters: true });
  await expect.poll(() => reaches(graph(), 'fpp_group_default', 'fpp_alsa_x'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});

test('the Simple mode group plays with no added delay', async ({ request }) => {
  // Regression: 0620d8f34. Simple mode's single member was given a 50 ms
  // delay, which only added latency (and buffer churn heard as clicks).
  // (The same commit's removal of node.passive from the filter chain's
  // playback side was undone by 00eb6eebf, which made it a setting.)
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
  writeSettings({ MediaBackend: 'pipewire', AudioOutput: '0' });
  await switchBackend(request, 'pipewire-simple');
  const simple = JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups-simple.json`));
  expect(simple.groups[0].members.map((m: any) => [m.cardId, m.delayMs])).toEqual([['X', 0]]);

  // The member's delay as the real PipeWire's filter chain runs it.
  loadGeneratedConf([], ['fpp_group_default', 'fpp_fx_g1_x'], { nullAdapters: true });
  expect(filterParams('fpp_fx_g1_x')).toMatchObject({ 'delay_l:Delay (s)': 0, 'delay_r:Delay (s)': 0 });
});

test('switching to Advanced mode answers before the PipeWire stack is restarted', async ({ request }) => {
  // Regression: 6b7196a19. Switching the Media Backend ran fppinit
  // setupAudio and applied the output groups and the input groups, each
  // restarting all three PipeWire services, all before the settings call
  // answered: the page sat for many seconds per change.  The config is now
  // written without restarts and fppinit (which restarts the stack once) runs
  // in the background.
  writeSettings({ MediaBackend: 'pipewire-simple', AudioOutput: '0' });
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'Out', enabled: true, channels: 2, members: [{ cardId: 'X', channels: 2 }] }],
  });
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'Bus', enabled: true, channels: 2, outputs: [1],
      members: [{ type: 'fppd_stream', sourceId: 'fppd_stream_1' }] }],
  });
  // A restart that takes as long as a real one does.
  standInAt('/usr/bin/systemctl', 'case "$1" in restart) sleep 2 ;; esac\nexit 0\n');
  inPlayer('rm', '-f', '/tmp/fpp-tests-systemctl.log');
  const took = await switchBackend(request, 'pipewire');
  const restarts = commandLog('systemctl').filter((l) => l.startsWith('restart'));
  expect(restarts, 'the settings call restarted PipeWire itself').toEqual([]);
  expect(took).toBeLessThan(5_000);
  // fppinit was still asked to bring the stack up, in the background.
  await expect.poll(() => commandLog('fppinit'), { timeout: 10_000 }).toContain('setupAudio');
  // And the config for the new mode was written first.
  expect(setting('PipeWireSinkName')).toBe('fpp_input_bus');
});
