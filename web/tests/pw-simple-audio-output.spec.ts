import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { stopPipeWire } from './pw-live';
import { describe, graph, loadGeneratedConf, reaches } from './pw-load';
import { CONFIG, cleanupPipeWire, fakeSoundCards, hwParams, readFile, standInAplay } from './pw-helpers';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// PipeWire's Simple mode: one output group on the AudioOutput card.  The cards
// are fakes under /proc/asound; the receiving end is a real PipeWire loading
// the generated conf (pw-load.ts), FPP's ALSA adapters as null sinks.
//
// Regression: be3548f1a ("stop the AudioOutput apply dying on an undefined
// function").  PUT /api/settings/AudioOutput called SetAudioOutput(), which
// lived in backup.php, which the API never includes: the card was written to
// the settings file, and then PHP died, before Simple mode rebuilt its one
// output group around the new card.  The setting named one card while the
// graph still fed the other.

test.skip(!container, 'stubs sound cards and reads the generated config inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => {
  stopPipeWire();
  cleanupPipeWire();
  restoreSettings();
});

test("choosing another sound card in Simple mode moves the output group to it", async ({ request }) => {
  test.setTimeout(180_000);
  fakeSoundCards([{ id: 'X' }, { id: 'Y' }]);
  standInAplay({ 'hw:X': hwParams(), 'hw:Y': hwParams() });
  setSettingInFile('AudioOutput', '0');
  setSettingInFile('MediaBackend', 'pipewire');
  const sw = await request.put('/api/settings/MediaBackend', { data: 'pipewire-simple', timeout: 120_000 });
  expect(sw.ok(), await sw.text()).toBe(true);
  const members = () => JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups-simple.json`)).groups[0].members.map((m: any) => m.cardId);
  // The control: Simple mode's group is on the first card.
  expect(members()).toEqual(['X']);

  const r = await request.put('/api/settings/AudioOutput', { data: '1', timeout: 120_000 });
  const text = await r.text();
  expect(r.status(), text).toBe(200);
  expect(JSON.parse(text).status, text).toBe('OK');
  expect(settingInFile('AudioOutput')).toBe('1');
  expect(members(), 'the group still feeds the old card').toEqual(['Y']);

  loadGeneratedConf([], ['fpp_group_default', 'fpp_alsa_y'], { nullAdapters: true });
  await expect.poll(() => reaches(graph(), 'fpp_group_default', 'fpp_alsa_y'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});

test('Simple mode makes one Default output group for the chosen card, and the pages say Simple mode', async ({ page, request }) => {
  // Feature: 009dbc5aa ("Enhance PipeWire support with Simple and Advanced
  // modes").  MediaBackend pipewire-simple builds its single output group,
  // "Default" (fpp_group_default), on the AudioOutput card by itself, kept
  // apart from the Advanced mode's groups; the group pages are Advanced-only
  // and say which mode is in use.
  test.setTimeout(180_000);
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
  setSettingInFile('AudioOutput', '0');
  setSettingInFile('MediaBackend', 'pipewire');
  const sw = await request.put('/api/settings/MediaBackend', { data: 'pipewire-simple', timeout: 120_000 });
  expect(sw.ok(), await sw.text()).toBe(true);
  const simple = JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups-simple.json`));
  expect(simple.groups.map((g: any) => [g.name, g.members.map((m: any) => m.cardId)])).toEqual([['Default', ['X']]]);
  expect(settingInFile('PipeWireSinkName')).toBe('fpp_group_default');
  await page.goto('/pipewire-audio.php');
  await expect(page.locator('.alsa-warning')).toContainText('Currently using: Simple PipeWire');

  loadGeneratedConf([], ['fpp_group_default', 'fpp_alsa_x'], { nullAdapters: true });
  await expect.poll(() => reaches(graph(), 'fpp_group_default', 'fpp_alsa_x'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});

test('apply_pipewire_simple_config builds the Simple mode config a first boot has none of', async () => {
  // Feature: 65d8aab27 ("add apply_pipewire_simple_config script").  fppinit
  // runs it when MediaBackend is pipewire-simple and there is no simple
  // groups JSON yet (a first boot, an OS upgrade).  It is run here as fppinit
  // runs it, with php, and the fake cards preloaded as php-fpm has them.
  test.setTimeout(180_000);
  fakeSoundCards([{ id: 'X' }]);
  standInAplay({ 'hw:X': hwParams() });
  setSettingInFile('AudioOutput', '0');
  setSettingInFile('MediaBackend', 'pipewire-simple');
  setSettingInFile('PipeWireSinkName', '');
  inPlayer('rm', '-f', `${CONFIG}/pipewire-audio-groups-simple.json`, '/etc/pipewire/pipewire.conf.d/97-fpp-audio-groups.conf');
  inPlayer('sh', '-c', 'LD_PRELOAD=/tmp/fpp-tests-fakeasound.so php /opt/fpp/scripts/apply_pipewire_simple_config 2>&1 || true');
  const simple = JSON.parse(readFile(`${CONFIG}/pipewire-audio-groups-simple.json`) || '{}');
  expect(simple.groups?.map((g: any) => g.members.map((m: any) => m.cardId)), 'no simple groups JSON was written').toEqual([['X']]);
  expect(settingInFile('PipeWireSinkName')).toBe('fpp_group_default');

  loadGeneratedConf([], ['fpp_group_default', 'fpp_alsa_x'], { nullAdapters: true });
  await expect.poll(() => reaches(graph(), 'fpp_group_default', 'fpp_alsa_x'),
    { timeout: 10_000, message: describe(graph()) }).toBe(true);
});
