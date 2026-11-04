import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The MultiSync page's Platform filter, over a systems list the test supplies
// (as multisync-page-filters.spec.ts does).

const system = (address: string, hostname: string, typeId: number, extra: object = {}) => ({
  address, hostname, local: 0, fppMode: 2, fppModeString: 'player',
  typeId, type: 'x', model: 'x',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
  uuid: `M1-${hostname}`, channelRanges: '', multiSyncCapable: 1, multisync: false,
  lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '', ...extra,
});

const SYSTEMS = { systems: [
  system('192.168.0.13', 'FPPTESTLOCAL', 13, { local: 1 }), // a Raspberry Pi 4
  system('192.168.0.21', 'FPPUNKNOWN', 1), // an FPP whose platform is not known
  system('192.168.0.22', 'FPPPI', 2),
  system('192.168.0.23', 'ESPV3', 0xc2, { fppMode: 8 }),
  system('192.168.0.24', 'ESP32', 0xc3, { fppMode: 8 }),
] };

async function load(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(5, { timeout: 15_000 });
  return page.locator('select.bootstrap-table-filter-control-platform');
}

const names = (page: Page) => page.locator('#fppSystems tr.systemRow').evaluateAll((rows) =>
  rows.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()).sort());

test('"FPP (Raspberry Pi)" leaves out an FPP whose platform is unknown', async ({ page }) => {
  // Regression: e7eaaee53.  Type 1 (an FPP of unknown platform) was counted as
  // a Pi, so the Pi filter listed it.
  const select = await load(page);
  await select.selectOption({ label: 'FPP (Raspberry Pi)' });
  await expect.poll(() => names(page)).toEqual(['FPPPI', 'FPPTESTLOCAL']);
});

test('the ESPixelStick filter takes both the ESP8266 and the ESP32 type ids', async ({ page }) => {
  // Regression: cdb2c5e58.  The ESP32's id (0xC3) was not recognised.
  const select = await load(page);
  await select.selectOption({ label: 'ESPixelStick' });
  await expect.poll(() => names(page)).toEqual(['ESP32', 'ESPV3']);
});
