import { test, expect } from './fixtures';
import type { Page, Request } from '@playwright/test';
import { container, inPlayer } from './container';

// Cape Info's EEPROM Upgrade tab: Restore from a firmware backup, and what
// the page does when the flash answers that the firmware is for another cape
// ("Cape does not match new firmware"): it names both and flashes again with
// force=true only if that is confirmed, with the same file and the same
// Reset-to-defaults choice.  upgradeCapeFirmware.php is answered by the test,
// so nothing is flashed; the backups are files in media/upload, removed after.

test.skip(!container, 'puts EEPROM backups in the run-web.sh container');

const UPLOAD = '/home/fpp/media/upload';
const BACKUPS = ['cape-eeprom-Backup-fpptests-20261101.bin', 'cape-eeprom-Backup-fpptests-20261113.bin'];
const MISMATCH = 'Checking firmware\nCape does not match new firmware\n  Cape: fpp-tests K16A-B v2\n  Firmware: fpp-tests F48 v3\nNot flashed\n';

// The Upgrade tab is there for an installed cape (cape-eeprom-upgrade-select.spec.ts).
const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';

test.beforeEach(() => {
  for (const f of BACKUPS) inPlayer('sh', '-c', `printf 'fpp-tests eeprom' > ${UPLOAD}/${f}`);
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'FppTestsCape', name: 'fpp-tests cape', version: '1.0', serialNumber: 'SN0001', provides: ['strings'],
    vendor: { name: 'fpp-tests Vendor' },
  }), CAPE_INFO);
});
test.afterEach(() => {
  for (const f of BACKUPS) inPlayer('rm', '-f', `${UPLOAD}/${f}`);
  inPlayer('rm', '-f', CAPE_INFO, '/home/fpp/media/tmp/eepromVendors.json');
});

type Flash = { query: URLSearchParams; body: string };
async function openTab(page: Page, answers: string[]) {
  const flashes: Flash[] = [];
  await page.route('**/upgradeCapeFirmware.php**', (r) => {
    const q = new URL(r.request().url()).searchParams;
    flashes.push({ query: q, body: r.request().postDataBuffer()?.toString('latin1') ?? '' });
    return r.fulfill({ body: answers[flashes.length - 1] ?? 'Done\n' });
  });
  await page.route('**/api/cape/eeprom/vendors**', (r) => r.fulfill({ json: { index: [] } }));
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  await expect(page.locator('#backupFile')).toBeVisible();
  return flashes;
}

async function restore(page: Page, file: string) {
  await page.selectOption('#backupFile', file);
  await expect(page.locator('#RestoreFirmware')).toBeEnabled();
  await page.click('#RestoreFirmware');
}

test('the backups are listed newest first, and Restore is off until one is chosen', async ({ page }) => {
  await openTab(page, []);
  await expect(page.locator('#backupFile option')).toHaveText(['-- Choose a backup EEPROM to restore --', BACKUPS[1], BACKUPS[0]]);
  await expect(page.locator('#RestoreFirmware')).toBeDisabled();
  await page.selectOption('#backupFile', BACKUPS[0]);
  await expect(page.locator('#RestoreFirmware')).toBeEnabled();
  await page.selectOption('#backupFile', '');
  await expect(page.locator('#RestoreFirmware')).toBeDisabled();
});

test('a restore flashes the chosen backup, with Reset to defaults as ticked', async ({ page }) => {
  const flashes = await openTab(page, ['Restored\n', 'Restored\n']);
  await expect(page.locator('#resetDefaultsConfig')).toBeChecked();
  await restore(page, BACKUPS[0]);
  await expect.poll(() => flashes.length).toBe(1);
  expect(flashes[0].query.get('filename')).toBe(BACKUPS[0]);
  expect(flashes[0].query.get('resetDefaults')).toBe('true');
  expect(flashes[0].query.get('force')).toBeNull();
  await expect(page.locator('#RestoreEEPROMText')).toHaveValue(/Restored/);
  await expect(page.locator('#RestoreEEPROMCloseButton, #RestoreEEPROM .modal-footer button').first()).toBeEnabled();

  // Unticked, the configuration is kept.
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  await page.locator('#resetDefaultsConfig').uncheck();
  await restore(page, BACKUPS[1]);
  await expect.poll(() => flashes.length).toBe(2);
  expect(flashes[1].query.get('filename')).toBe(BACKUPS[1]);
  expect(flashes[1].query.get('resetDefaults')).toBeNull();
});

test('a backup for another cape is flashed again with force only once confirmed', async ({ page }) => {
  const flashes = await openTab(page, [MISMATCH, 'Forced\n']);
  const asked: string[] = [];
  page.once('dialog', (d) => { asked.push(d.message()); return d.accept(); });
  await restore(page, BACKUPS[1]);
  await expect.poll(() => flashes.length).toBe(2);
  expect(asked).toEqual(['Are you sure you want to replace the firmware for cape:\nCape: fpp-tests K16A-B v2\n\nWith the firmware for:\nFirmware: fpp-tests F48 v3\n']);
  expect(flashes[1].query.get('force')).toBe('true');
  expect(flashes[1].query.get('filename')).toBe(BACKUPS[1]);
  expect(flashes[1].query.get('resetDefaults')).toBe('true');
});

test('a backup for another cape is not flashed when the question is declined', async ({ page }) => {
  const flashes = await openTab(page, [MISMATCH]);
  page.once('dialog', (d) => d.dismiss());
  await restore(page, BACKUPS[0]);
  await expect.poll(() => flashes.length).toBe(1);
  await page.waitForTimeout(1000);
  expect(flashes).toHaveLength(1);
  // The log stays, so the reason can be read, and the dialog can be closed.
  await expect(page.locator('#RestoreEEPROMText')).toHaveValue(/Cape does not match new firmware/);
});

test('an Upgrade with nothing chosen says so, and a mismatched vendor image is forced only once confirmed', async ({ page }) => {
  const flashes = await openTab(page, [MISMATCH, 'Forced\n']);
  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); return d.accept(); });
  // Nothing in the version list and no file: the Upgrade is refused.
  await page.evaluate(() => { $('#UpdateFirmware').prop('disabled', false); $('#eepromVendorCapeVersions').append("<option value='' selected></option>"); });
  await page.click('#UpdateFirmware');
  await expect.poll(() => alerts).toEqual(['You must choose a downloadable file from the list or pick a local file to upload.']);
  expect(flashes).toHaveLength(0);

  // A version from the list: posted as filename, then forced after the question.
  const url = 'https://vendor.fpp-tests.invalid/fpp-tests%20F48.bin';
  await page.evaluate((u) => { $('#eepromVendorCapeVersions').append($('<option>').val(u).text('3.0')).val(u); }, url);
  await page.click('#UpdateFirmware');
  await expect.poll(() => flashes.length).toBe(2);
  expect(alerts[1]).toContain('Firmware: fpp-tests F48 v3');
  for (const f of flashes) expect(f.body).toContain(url);
  expect(flashes[0].query.get('force')).toBeNull();
  expect(flashes[1].query.get('force')).toBe('true');
  expect(flashes[1].query.get('resetDefaults')).toBe('true');
});
