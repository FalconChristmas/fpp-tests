import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Cape Info's EEPROM Upgrade tab: the Vendor and Cape/Hat lists come from the
// fpp-data vendor index on GitHub and each vendor's own list.  The player asks
// for them first (api/cape/eeprom/vendors); it cannot reach GitHub here (the
// names are on loopback), so the page fetches them from the browser, as for
// an offline show box driven from an online laptop -- and those fetches are
// answered by routes.  The installed cape is media/tmp/cape-info.json, as
// cape detection writes it from the EEPROM.

test.skip(!container, 'writes the cape info inside the run-web.sh container');
// The vendor hosts are added to connect-src only once the player has the index.
test.use({ bypassCSP: true });

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const INDEX = 'https://raw.githubusercontent.com/FalconChristmas/fpp-data/master/eepromVendors.json';
const LIST = 'https://vendor.fpp-tests.invalid/eeproms.json';
const OTHER = 'https://other.fpp-tests.invalid/eeproms.json';

const capes = (names: string[]) => Object.fromEntries(names.map((n) => [n, {
  versions: { '1.0': { url: `https://vendor.fpp-tests.invalid/${encodeURIComponent(n)}.bin` } },
}]));

async function vendorLists(page: Page) {
  const answer = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
                                       headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route(INDEX, (r) => r.fulfill(answer({ vendors: [{ name: 'Other', url: OTHER }, { name: 'fpp-tests', url: LIST }] })));
  await page.route(LIST, (r) => r.fulfill(answer({ name: 'fpp-tests Vendor', capes: capes(['fpp-tests other cape', 'fpp-tests cape']) })));
  await page.route(OTHER, (r) => r.fulfill(answer({ name: 'Another Vendor', capes: capes(['another cape']) })));
}

let uiLevel = '';

test.beforeEach(async ({ request }) => {
  uiLevel = (await (await request.get('/api/settings/uiLevel')).json()).value ?? '0';
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', CAPE_INFO, '/home/fpp/media/tmp/eepromVendors.json');
  await request.put('/api/settings/uiLevel', { data: uiLevel });
});

function installCape(vendor: string) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'FppTestsCape', name: 'fpp-tests cape', version: '1.0', serialNumber: 'SN0001', provides: ['strings'],
    vendor: { name: vendor },
  }), CAPE_INFO);
}

async function setLevel(request: APIRequestContext, level: string) {
  const r = await request.put('/api/settings/uiLevel', { data: level });
  expect(r.ok()).toBe(true);
}

async function openUpgrade(page: Page) {
  await vendorLists(page);
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  // Both vendors' lists have arrived.
  await expect(page.locator('#eepromVendorList option')).toHaveCount(3, { timeout: 15_000 });
}

test('the EEPROM upgrade selects the installed cape, locked at the Basic UI level and free at Advanced', async ({ page, request }) => {
  // Feature: 773d6ea0f (#2564).  The vendor and cape lists default to the
  // installed cape; at the Basic level they are locked to it, so only the
  // version can be chosen.
  // Also dd72a0ac5: each version's option holds the version's URL (the
  // option value was "undefined").
  installCape('fpp-tests Vendor');
  await setLevel(request, '0');
  await openUpgrade(page);
  const vendor = page.locator('#eepromVendorList');
  const cape = page.locator('#eepromVendorCapes');
  await expect(vendor).toHaveValue('fpp-tests Vendor');
  await expect(cape).toHaveValue('fpp-tests cape');
  await expect(vendor).toBeDisabled();
  await expect(cape).toBeDisabled();
  await expect(page.locator('#eepromHardwareLockedNote')).toBeVisible();
  // The version list is the installed cape's.
  await expect(page.locator('#eepromVendorCapeVersions')).toHaveValue('https://vendor.fpp-tests.invalid/fpp-tests%20cape.bin');

  await setLevel(request, '1');
  await openUpgrade(page);
  await expect(vendor).toHaveValue('fpp-tests Vendor');
  await expect(cape).toHaveValue('fpp-tests cape');
  await expect(vendor).toBeEnabled();
  await expect(cape).toBeEnabled();
  await expect(page.locator('#eepromHardwareLockedNote')).toBeHidden();
});

test('the installed cape\'s vendor is found when its EEPROM names it with a suffix the vendor list leaves off', async ({ page, request }) => {
  // Regression: 70dcffb22 (#2564).  The vendor was matched by exact name, so
  // a cape whose EEPROM says "fpp-tests Vendor, LLC" against a list named
  // "fpp-tests Vendor" was not selected.
  installCape('fpp-tests Vendor, LLC');
  await setLevel(request, '1');
  await openUpgrade(page);
  await expect(page.locator('#eepromVendorList')).toHaveValue('fpp-tests Vendor');
  await expect(page.locator('#eepromVendorCapes')).toHaveValue('fpp-tests cape');
});

test('the vendor named exactly wins over one whose name is only a prefix, whichever list arrives first', async ({ page, request }) => {
  // Regression: the vendor lists arrive in any order and the first one whose
  // name matched took the selection for good; since 70dcffb22 a prefix
  // matches, so a vendor named "fpp-tests" whose list came first took the
  // cape of "fpp-tests Vendor".  Its list has a cape of the same name, so the
  // version (and the download it leads to) was the wrong vendor's, and at the
  // Basic level the lists were locked to it.
  const PREFIX = 'https://prefix.fpp-tests.invalid/eeproms.json';
  const answer = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
                                       headers: { 'Access-Control-Allow-Origin': '*' } });
  await page.route(INDEX, (r) => r.fulfill(answer({ vendors: [{ name: 'Prefix', url: PREFIX }, { name: 'fpp-tests', url: LIST }] })));
  await page.route(PREFIX, (r) => r.fulfill(answer({ name: 'fpp-tests', capes: {
    'fpp-tests cape': { versions: { '1.0': { url: 'https://prefix.fpp-tests.invalid/fpp-tests%20cape.bin' } } },
  } })));
  // The exact one arrives after it.
  await page.route(LIST, async (r) => {
    await new Promise((done) => setTimeout(done, 1500));
    await r.fulfill(answer({ name: 'fpp-tests Vendor', capes: capes(['fpp-tests other cape', 'fpp-tests cape']) }));
  });
  installCape('fpp-tests Vendor');
  await setLevel(request, '0');
  await page.goto('/cape-info.php');
  await page.locator('#eeprom-upgrade-tab').click();
  const vendor = page.locator('#eepromVendorList');
  await expect(vendor.locator('option')).toHaveCount(3, { timeout: 15_000 });
  await expect(vendor).toHaveValue('fpp-tests Vendor');
  await expect(page.locator('#eepromVendorCapes')).toHaveValue('fpp-tests cape');
  await expect(page.locator('#eepromVendorCapeVersions')).toHaveValue('https://vendor.fpp-tests.invalid/fpp-tests%20cape.bin');
  // Still locked to the installed cape at the Basic level.
  await expect(vendor).toBeDisabled();
  await expect(page.locator('#eepromVendorCapes')).toBeDisabled();
  await expect(page.locator('#eepromHardwareLockedNote')).toBeVisible();
});
