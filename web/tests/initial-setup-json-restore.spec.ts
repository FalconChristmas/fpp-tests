import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Feature: 50583560b ("Initial Setup - Implement backup file restore
// functionality", #2671). A player being set up for the first time can be
// given its configuration from a backup's JSON file, in the setup wizard's
// Restore from Backup dialog, instead of being taken through the wizard and
// then restored from the Backup page. The restore finishes setup and asks for
// a reboot; a file that is not a backup is refused and changes nothing.
//
// The receiving ends: the settings file the restore wrote, the settings API
// reading it back, and the setup gate letting the next page through.
//
// First run is staged by taking the completion flag out of the settings file
// (the handler refuses once setup is done, since 08ba56477).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const BACKUPS = `${MEDIA}/config/backups`;
const SAVED = '/tmp/fpp-tests-initial-setup-json-restore.backups';

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  inPlayer('sh', '-c', `mkdir -p ${BACKUPS} && ls ${BACKUPS} > ${SAVED}`);
});
test.afterEach(() => {
  restoreSettings();
  inPlayer('sh', '-c', `cd ${BACKUPS} && ls | grep -vxF -f ${SAVED} | xargs -r rm -f; rm -f ${SAVED} /fpp_restored`);
});

test('the setup wizard restores a backup file, and refuses one that is not a backup', async ({ page, request }) => {
  test.setTimeout(90_000);
  setSettingInFile('initialSetup-02', '0');
  setSettingInFile('HostDescription', '');
  setSettingInFile('rebootFlag', '0');

  await page.goto('/initialSetup.php');
  await page.click('input[value="Restore from Backup"]');
  await expect(page.locator('#restoreDialog')).toBeVisible();

  // Not a backup.
  await page.setInputFiles('#restoreFileInput', { name: 'fpp-tests-bad.json', mimeType: 'application/json', buffer: Buffer.from('{"settings": ') });
  await page.click('#uploadRestoreBtn');
  await expect(page.locator('#restoreStatus')).toContainText('Invalid JSON', { timeout: 30_000 });
  expect(settingInFile('initialSetup-02'), 'a refused file finished setup').toBe('0');
  expect(settingInFile('HostDescription')).toBe('');

  // A backup.
  const backup = { fpp_backup_version: '8.0', settings: { system_settings: [{ HostDescription: 'fpp-tests-setup-restored' }] } };
  await page.setInputFiles('#restoreFileInput', { name: 'fpp-tests-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.click('#uploadRestoreBtn');
  await expect(page, 'the wizard did not move on after the restore').toHaveURL(/index\.php/, { timeout: 30_000 });

  expect(settingInFile('HostDescription'), 'the backup was not restored').toBe('fpp-tests-setup-restored');
  expect((await (await request.get('/api/settings/HostDescription')).json()).value).toBe('fpp-tests-setup-restored');
  expect(settingInFile('initialSetup-02'), 'the restore did not finish setup').toBe('1');
  expect(settingInFile('rebootFlag'), 'the restore did not ask for a reboot').toBe('1');
  // The gate no longer sends every page to the wizard.
  const index = await (await request.get('/index.php')).text();
  expect(index).not.toContain('url=initialSetup.php');
});
