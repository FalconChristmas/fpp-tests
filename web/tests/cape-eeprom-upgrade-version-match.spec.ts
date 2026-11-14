import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Cape Info's EEPROM Upgrade tab, for the installed cape: the Version list is
// matched against the cape's hardware version, so the image picked by default
// is one for this hardware rather than the first the vendor lists.  The
// vendor lists are answered by routes, as in cape-eeprom-upgrade-select.spec.ts.

test.skip(!container, 'writes the cape info inside the run-web.sh container');
test.use({ bypassCSP: true });

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const INDEX = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/master/eepromVendors.json';
const LIST = 'https://vendor.fpp-tests.invalid/eeproms.json';
const url = (n: string) => `https://vendor.fpp-tests.invalid/${n}.bin`;

async function vendorList(page: Page, versions: Record<string, string>) {
  const answer = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
                                       headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route(INDEX, (r) => r.fulfill(answer({ vendors: [{ name: 'fpp-tests', url: LIST }] })));
  await page.route(LIST, (r) => r.fulfill(answer({ name: 'fpp-tests Vendor', capes: {
    'fpp-tests cape': { versions: Object.fromEntries(Object.entries(versions).map(([label, n]) => [label, { url: url(n) }])) },
  } })));
}

function installCape(version: string, eepromVersion: string) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'FppTestsCape', name: 'fpp-tests cape', version, eepromVersion, serialNumber: 'SN0001',
    provides: ['strings'], vendor: { name: 'fpp-tests Vendor' },
  }), CAPE_INFO);
}

async function openUpgrade(page: Page) {
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  await expect(page.locator('#eepromVendorCapes')).toHaveValue('fpp-tests cape', { timeout: 15_000 });
}

test.afterEach(async () => {
  inPlayer('rm', '-f', CAPE_INFO, '/home/fpp/media/tmp/eepromVendors.json');
});

test('the EEPROM upgrade picks the newest image for the installed hardware version, not the first listed', async ({ page }) => {
  // Regression: c40bae802.  The Version list took the vendor's order and the
  // first entry was selected, so Upgrade was ready to flash a hardware 1.x
  // image onto a 2.1 cape.
  await vendorList(page, {
    '1.0-1.2': 'hw1',
    '2.0/2.1': 'hw2',
    'Hardware Version 2.1 / EEPROM 2.1.3': 'e213',
    'Hardware Version 2.1 / EEPROM 2.1.5': 'e215',
    '3.0': 'hw3',
  });
  installCape('2.1', '2.1.3');
  await openUpgrade(page);
  const versions = page.locator('#eepromVendorCapeVersions');
  await expect(versions).toHaveValue(url('e215'));
  await expect(page.locator('#UpdateFirmware')).toBeEnabled();
  // The installed image is marked, and the images for other hardware are
  // still there to recover a cape flashed with the wrong one.
  await expect(versions.locator('option', { hasText: '(installed)' })).toHaveAttribute('value', url('e213'));
  await expect(versions.locator(`option[value="${url('hw1')}"]`)).toHaveCount(1);
  await expect(page.locator('#eepromInstalledVersion')).toContainText('Hardware 2.1');
});

test('with two images for the installed hardware that differ only by display colour, none is picked and Upgrade waits', async ({ page }) => {
  // Regression: c40bae802.  The first image listed was selected, whatever
  // the cape's display: Upgrade could flash the wrong colour's image.
  await vendorList(page, { '1.0 (White)': 'w1', '2.1 (White)': 'w2', '2.1 (Blue)': 'b2' });
  installCape('2.1', '');
  await openUpgrade(page);
  const versions = page.locator('#eepromVendorCapeVersions');
  await expect(page.locator('#eepromVersionMatchNote')).toContainText('More than one image matches hardware 2.1');
  await expect(versions).toHaveValue('');
  await expect(page.locator('#UpdateFirmware')).toBeDisabled();
  // Picking one makes Upgrade ready.
  await versions.selectOption(url('b2'));
  await expect(page.locator('#UpdateFirmware')).toBeEnabled();
});
