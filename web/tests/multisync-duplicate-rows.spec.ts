import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// One MultiSync row per device.  fppd lists a device once per address it
// knows it at, and not every entry carries the device's UUID (an address
// learned from a sync packet or a ping has none), so the page has to put a
// UUID-less entry on the row of the device it belongs to.  The systems list
// is answered by the test; status polls get nothing back.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

async function rows(page: Page, systems: unknown[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow').first()).toBeVisible({ timeout: 15_000 });
  // Let the table settle: the list is drawn once, then re-rendered.
  await page.waitForTimeout(1000);
  return page.locator('#fppSystems tr.systemRow').evaluateAll((trs) =>
    trs.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()));
}

const LOCAL = system('192.168.0.13', 'FPPTESTLOCAL', 'M1-fpptests-local', 1);

test("an address listed without the device's UUID goes on that device's row", async ({ page }) => {
  // Regression: c4d154827.  The row key was the entry's UUID, or
  // hostname+mode when it had none, so the same device listed once with its
  // UUID and once without (at another address) made two rows.
  const got = await rows(page, [
    LOCAL,
    system('192.168.0.21', 'fpptests-remote', 'M1-fpptests-remote'),
    system('192.168.0.121', 'fpptests-remote', ''),
  ]);
  expect(got).toEqual(['FPPTESTLOCAL', 'fpptests-remote']);
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
  await expect(row).toContainText('192.168.0.21');
  await expect(row).toContainText('192.168.0.121');
});

test('an address without a UUID is not put on a row when two devices share its hostname', async ({ page }) => {
  // c4d154827 again: two devices left on the same hostname have different
  // UUIDs, and a UUID-less entry with that hostname could be either, so it
  // keeps a row of its own rather than joining the first one seen.
  const got = await rows(page, [
    LOCAL,
    system('192.168.0.31', 'fpptests-same', 'M1-fpptests-one'),
    system('192.168.0.32', 'fpptests-same', 'M1-fpptests-two'),
    system('192.168.0.33', 'fpptests-same', ''),
  ]);
  expect(got).toEqual(['FPPTESTLOCAL', 'fpptests-same', 'fpptests-same', 'fpptests-same']);
});
