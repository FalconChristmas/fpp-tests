import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A system that joins the network after the MultiSync page has loaded shows
// up in its table without reloading the page.  The list and the polls are
// answered by the test; `joined` adds the third system to the list.

const base = {
  fppMode: 2, fppModeString: 'player', typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000, channelRanges: '',
  multiSyncCapable: 1, multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
};

const LOCAL = { ...base, address: '192.168.0.13', hostname: 'FPPTESTLOCAL', local: 1, uuid: 'M1-fpptests-local' };
const REMOTE = { ...base, address: '192.168.0.21', hostname: 'FPPTESTREMOTE', local: 0, uuid: 'M1-fpptests-remote' };
const NEWCOMER = { ...base, address: '192.168.0.30', hostname: 'FPPTESTNEWCOMER', local: 0, uuid: 'M1-fpptests-new' };

async function serve(page: Page, list: () => object[]) {
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: list() } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
}

const rows = (page: Page) => page.locator('#fppSystems tr.systemRow');

test('with auto refresh on, a system that joins appears without a reload', async ({ page, request }) => {
  // Regression: 36bc7e7b1.  The list was read once at page load; auto refresh
  // only re-polled the rows already shown, so a new system never appeared.
  test.setTimeout(60_000);
  let joined = false;
  await serve(page, () => (joined ? [LOCAL, REMOTE, NEWCOMER] : [LOCAL, REMOTE]));
  await request.put('/api/settings/MultiSyncRefreshStatus', { data: '1' });
  try {
    await page.goto('/multisync.php');
    await expect(rows(page)).toHaveCount(2, { timeout: 15_000 });
    joined = true;
    await expect(rows(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('tr.systemRow', { hasText: 'FPPTESTNEWCOMER' })).toBeVisible();
  } finally {
    await request.put('/api/settings/MultiSyncRefreshStatus', { data: '0' });
  }
});

test('Refresh adds a system that joined, once no row is checked', async ({ page, request }) => {
  // Regression: 36bc7e7b1.  Refresh re-polled status only.  Adding a system
  // rebuilds the table, so it waits while a row is checked rather than clear
  // the user's selection.
  let joined = false;
  await serve(page, () => (joined ? [LOCAL, REMOTE, NEWCOMER] : [LOCAL, REMOTE]));
  await request.put('/api/settings/MultiSyncRefreshStatus', { data: '0' });
  await page.goto('/multisync.php');
  await expect(rows(page)).toHaveCount(2, { timeout: 15_000 });
  joined = true;

  const box = page.locator(`input.multisyncRowCheckbox[name="${REMOTE.address}"]`);
  await box.check();
  const listed = page.waitForResponse((r) => r.url().includes('/api/fppd/multiSyncSystems'));
  await page.locator('#refreshStatsButton').click();
  await listed;
  await page.waitForTimeout(500);
  await expect(rows(page)).toHaveCount(2);
  await expect(box).toBeChecked();

  await box.uncheck();
  await page.locator('#refreshStatsButton').click();
  await expect(rows(page)).toHaveCount(3, { timeout: 10_000 });
});
