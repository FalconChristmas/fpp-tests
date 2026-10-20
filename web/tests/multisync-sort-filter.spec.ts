import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Sorting and filtering the MultiSync systems table.  Its cells are HTML whose
// opening markup carries per-row ids (made from the row's IP or UUID), so a
// column sorted on the raw cell compares those ids instead of what is shown.
// The systems list is answered by the test, as in multisync.spec.ts; status
// polls get nothing back, so every row shows what the list says.

function system(address: string, hostname: string, typeId: number, type: string, model: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: typeId > 0 && typeId < 128 ? 2 : 1,
    fppModeString: typeId > 0 && typeId < 128 ? 'player' : 'bridge',
    typeId, type, model, version: typeId > 0 && typeId < 128 ? '10.x-master-1-gaaa1111bb' : '1.0',
    majorVersion: 10, minorVersion: 1000, uuid, channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

// Hostnames and platforms in an order that neither the IPs nor the UUIDs
// share, so a sort on either of those shows up.
const SYSTEMS = {
  systems: [
    system('192.168.0.1', 'aaa', 14, 'Raspberry Pi 5', 'Raspberry Pi 5 Model B', 'M1-a0000001', 1),
    system('192.168.0.2', 'fpp10', 13, 'Raspberry Pi 4', 'Raspberry Pi 4 Model B', 'M1-b0000002'),
    system('192.168.0.3', 'fpp2', 66, 'BeagleBone Black', 'BeagleBone Black', 'M1-c0000003'),
    system('192.168.0.4', 'FPP3', 8, 'Raspberry Pi 3', 'Raspberry Pi 3 Model B', 'M1-d0000004'),
    system('192.168.0.5', 'zz-hinks', 0xfd, 'HinksPix', 'HinksPix', ''),
    system('192.168.0.6', 'zz-unknown', 0, 'Unknown System Type', 'Unknown', ''),
  ],
};

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(6, { timeout: 15_000 });
}

async function hostnames(page: Page): Promise<string[]> {
  return page.locator('#fppSystems tr.systemRow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()));
}

async function sortBy(page: Page, field: string) {
  await page.locator(`#fppSystemsTable thead th[data-field="${field}"] .sortable`).click();
}

function sortedEitherWay(got: string[], want: string[]) {
  expect([JSON.stringify(want), JSON.stringify([...want].reverse())]).toContain(JSON.stringify(got));
}

test('the hostname column sorts by hostname, naturally', async ({ page }) => {
  // Feature: 6e8e0e266.  Before it a plain string sort of the cell's HTML
  // compared the IP in each hostname span's id.
  await openMultisync(page);
  await sortBy(page, 'hostname');
  sortedEitherWay(await hostnames(page), ['aaa', 'fpp2', 'FPP3', 'fpp10', 'zz-hinks', 'zz-unknown']);
});

test('the platform column sorts by platform', async ({ page }) => {
  // Regression: 4505fe13b (#2962).  The column sorted on its raw HTML, which
  // opens with a span whose id is the row's UUID: the rows came out in UUID
  // order, platforms interleaved.
  await openMultisync(page);
  await sortBy(page, 'platform');
  const order = await hostnames(page);
  // BeagleBone Black, HinksPix, Raspberry Pi 3, 4, 5, Unknown System Type
  sortedEitherWay(order, ['fpp2', 'zz-hinks', 'FPP3', 'fpp10', 'aaa', 'zz-unknown']);
});

test('the platform filter can show every non-FPP system', async ({ page }) => {
  // Feature: f3d26c91e ("Non-FPP (All)": everything that is not an FPP
  // instance, including systems of unknown type).
  await openMultisync(page);
  const select = page.locator('#fppSystemsTable thead select')
    .filter({ has: page.locator('option[value="FPP (BeagleBone)"]') });
  await select.selectOption({ value: 'Non-FPP (All)' });
  await expect(page.locator('tr.systemRow', { hasText: 'zz-hinks' })).toBeVisible();
  await expect(page.locator('tr.systemRow', { hasText: 'zz-unknown' })).toBeVisible();
  for (const h of ['fpp10', 'fpp2', 'FPP3']) {
    await expect(page.locator('tr.systemRow', { hasText: h })).not.toBeVisible();
  }
});
