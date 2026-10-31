import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// More of the Cape Info page: the EEPROM version row, the driver named from
// a panel cape's layout, and the EEPROM upgrade tab's version list (platform
// filter and vendor notes).  The vendor lists are answered by routes, as in
// cape-eeprom-upgrade-select.spec.ts.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CAPE_INFO = `${MEDIA}/tmp/cape-info.json`;
const PANELS_DIR = `${MEDIA}/tmp/panels`;

function read(path: string): string | null {
  const out = inPlayer('sh', '-c', 'if [ -e "$1" ]; then echo yes; cat "$1"; else echo no; fi', 'sh', path);
  return out.startsWith('yes\n') ? out.slice(4) : null;
}
function write(path: string, content: string) {
  inPlayer('sh', '-c', 'mkdir -p "$(dirname "$1")" && printf "%s" "$2" > "$1"', 'sh', path, content);
}
const cape = (extra: object = {}) => ({ id: 'FppTestsCape', name: 'fpp-tests cape', version: '1.0', serialNumber: 'SN0001',
  provides: ['strings'], vendor: { name: 'fpp-tests Vendor' }, ...extra });

let savedInfo: string | null = null;
test.beforeEach(() => {
  savedInfo = read(CAPE_INFO);
});
test.afterEach(() => {
  if (savedInfo === null) inPlayer('rm', '-f', CAPE_INFO); else write(CAPE_INFO, savedInfo);
  inPlayer('rm', '-rf', PANELS_DIR, `${MEDIA}/tmp/eepromVendors.json`);
});

test('the EEPROM version is shown when the cape has one, separately from its hardware version', async ({ page }) => {
  // Feature: 508fd6db8.
  write(CAPE_INFO, JSON.stringify(cape({ eepromVersion: '2.7-fpp-tests' })));
  await page.goto('/cape-info.php');
  await expect(page.locator('tr', { hasText: 'EEPROM Version:' })).toContainText('2.7-fpp-tests');
  write(CAPE_INFO, JSON.stringify(cape()));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).not.toContainText('EEPROM Version:');
});

test('a panel cape is named with the driver its panel layout says', async ({ page }) => {
  // Feature: 60abede41.  Only the strings layouts were searched for the
  // driver; a panel cape's layout (tmp/panels) was not.
  write(CAPE_INFO, JSON.stringify(cape({ provides: ['panels'] })));
  write(`${PANELS_DIR}/FppTestsPanels.json`, JSON.stringify({ name: 'FppTestsPanels', driver: 'BBShiftPanel' }));
  await page.goto('/cape-info.php');
  await expect(page.locator('body')).toContainText('BBShiftPanel Channel Output driver');
});

// The player gives the page its vendors (api/cape/eeprom/vendors); the test
// answers that with one vendor of its own.
async function vendorList(page: Page, versions: object) {
  await page.route('**/api/cape/eeprom/vendors', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ vendors: [{ name: 'fpp-tests Vendor', capes: { 'fpp-tests cape': { description: 'fpp-tests', versions } } }] }) }));
}

async function openUpgrade(page: Page) {
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  await expect(page.locator('#eepromVendorList option', { hasText: 'fpp-tests Vendor' })).toHaveCount(1, { timeout: 15_000 });
  await page.locator('#eepromVendorList').selectOption({ label: 'fpp-tests Vendor' });
  await page.locator('#eepromVendorCapes').selectOption({ label: 'fpp-tests cape' });
}

test('the version list holds only the versions made for this player\'s platform', async ({ page, request }) => {
  // Feature: 55cff103e.  An entry may name the platforms it is for.
  await request.put('/api/settings/uiLevel', { data: '1' });
  write(CAPE_INFO, JSON.stringify(cape()));
  await vendorList(page, {
    '1.0': { url: 'https://vendor.fpp-tests.invalid/any.bin' },
    '2.0-beagle': { url: 'https://vendor.fpp-tests.invalid/beagle.bin', platforms: ['BeagleBone Black'] },
    '3.0-docker': { url: 'https://vendor.fpp-tests.invalid/docker.bin', platforms: ['Docker', 'Linux'] },
  });
  await openUpgrade(page);
  const options = await page.locator('#eepromVendorCapeVersions option').allInnerTexts();
  expect(options).toContain('1.0');
  expect(options).not.toContain('2.0-beagle');
  expect(options).toContain('3.0-docker');
  await request.put('/api/settings/uiLevel', { data: '0' });
});

test('a version\'s vendor notes show when it is picked and not for one without', async ({ page, request }) => {
  // Feature: cbf13f53e.
  await request.put('/api/settings/uiLevel', { data: '1' });
  write(CAPE_INFO, JSON.stringify(cape()));
  await vendorList(page, {
    '1.0': { url: 'https://vendor.fpp-tests.invalid/plain.bin' },
    '2.0': { url: 'https://vendor.fpp-tests.invalid/noted.bin', notes: 'Remove the jumper before flashing.' },
  });
  await openUpgrade(page);
  const notes = page.locator('#eepromVendorVersionNotes');
  await page.locator('#eepromVendorCapeVersions').selectOption({ label: '2.0' });
  await expect(notes).toContainText('Remove the jumper before flashing.');
  await expect(page.locator('#eepromVendorVersionNotesLabel')).toBeVisible();
  await page.locator('#eepromVendorCapeVersions').selectOption({ label: '1.0' });
  await expect(page.locator('#eepromVendorVersionNotesLabel')).toBeHidden();
  await request.put('/api/settings/uiLevel', { data: '0' });
});
