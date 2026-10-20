import { test, expect } from './fixtures';
import { container } from './container';
import { BACKUPS, SETTINGS, putFile, readFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// The settings file is rewritten whole on every change, so whatever the parser
// misreads is written back.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

// Regression: c0f5ae635 ("a line with no '=' is not a setting"). A hand-edited
// '#' comment or a stray line became a key with a null value, which every
// later save wrote back as 'key = ""' and every backup carried.
test('a line with no "=" in the settings file does not become a setting', async ({ request }) => {
  putFile(SETTINGS, readFile(SETTINGS).trimEnd() + '\n# fpp-tests hand comment\nfpptestsjunk\n');
  const r = await request.put('/api/settings/HostDescription?skipBackup=1', { data: 'fpp-tests-rewrite' });
  expect(r.ok()).toBe(true);
  const file = readFile(SETTINGS);
  // The control: the save rewrote the file.
  expect(settingInFile('HostDescription')).toBe('fpp-tests-rewrite');
  expect(file, 'a stray line was written back as a setting').not.toMatch(/^fpptestsjunk\s*=/m);
  expect(file).not.toMatch(/^# fpp-tests hand comment\s*=/m);

  const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests stray line' })).json();
  const name = String(made.backup_file_path).split('/').pop();
  try {
    const carried = JSON.parse(readFile(`${BACKUPS}/${name}`)).settings.system_settings[0];
    expect(carried.HostDescription).toBe('fpp-tests-rewrite');
    expect(Object.keys(carried)).not.toContain('fpptestsjunk');
    expect(Object.keys(carried)).not.toContain('# fpp-tests hand comment');
  } finally {
    await request.delete(`/api/backups/configuration/JsonBackups/${name}`);
  }
});

// Regression: ca1181176 ("keep JSON values intact when DeleteSettingFromFile()
// rewrites"). Removing a setting re-read the file with stock parse_ini_file(),
// which strips embedded double quotes and turns yes/on/off into 1 and '', and
// wrote that back: privacyConsent came out as {settings:{...}}, no longer JSON.
// Resetting the audio backend is what removes settings this way.
test('removing a setting leaves the JSON and word values of the others intact', async ({ request }) => {
  const record = settingInFile('privacyConsent');
  expect(record, 'the setup wizard left no consent record').toBeTruthy();
  setSettingInFile('HostDescription', 'off');
  setSettingInFile('AES67Enabled', '1');
  const r = await request.get('/resetConfig.php?areas=audiobackend', { timeout: 120_000 });
  expect(r.ok()).toBe(true);
  expect(await r.text()).toContain('Cleared setting: AES67Enabled');
  // The control: the setting was removed.
  expect(settingInFile('AES67Enabled')).toBeUndefined();
  expect(settingInFile('privacyConsent'), 'the JSON value was rewritten without its quotes').toBe(record);
  expect(JSON.parse(settingInFile('privacyConsent')!).uuid).toBeTruthy();
  expect(settingInFile('HostDescription')).toBe('off');
  // The reset restarts fppd; let it come back before the next test.
  await expect.poll(async () => (await request.get('/api/fppd/status').catch(() => null))?.ok() ?? false,
    { timeout: 60_000 }).toBe(true);
});
