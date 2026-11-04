import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// What a MultiSync row says about a remote in each state it can report.  The
// systems list and the status answers are the test's, as in multisync.spec.ts.

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const status = (status_name: string, extra: Record<string, unknown> = {}) => ({
  status_name, mode_name: 'remote', mode: 8, warnings: [], wifi: [], interfaces: [],
  current_playlist: { playlist: '', type: '', index: '0', count: '0' },
  advancedView: { Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', IPs: [REMOTE], Utilization: { CPU: 12, Memory: 34 } },
  ...extra,
});

async function open(page: Page, answer: (url: string) => unknown) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote')] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [REMOTE]: answer(route.request().url()) } as object }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.locator('#refreshStatsButton').click();
  await polled;
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
}

for (const [name, text] of [
  ['paused', /Paused/],
  ['stopping gracefully', /Stopping Gracefully(?! After Loop)/],
  ['stopping gracefully after loop', /Stopping Gracefully After Loop/],
] as const) {
  test(`a remote that is "${name}" says so in its row`, async ({ page }) => {
    // Regression: fa53051b0 (a few missing statuses).
    const row = await open(page, () => status(name));
    await expect(row).toContainText(text, { timeout: 15_000 });
  });
}

test('a remote that cannot be reached says so and its row is not filled with other cells', async ({ page }) => {
  // Regression: 2a4a25598.
  const row = await open(page, () => status('unreachable', { fppd: 'unknown', status: 'stopped', advancedView: undefined }));
  await expect(row).toContainText(/unreachable/i, { timeout: 15_000 });
});

test('a remote whose status answer is empty is skipped without breaking the table', async ({ page }) => {
  // Regression: 5171676b5.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const row = await open(page, () => null);
  await expect(row).toBeVisible();
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2);
});

test("a remote's mode cell follows its status when it changes between refreshes", async ({ page }) => {
  // Regression: f9d225def.  A refresh updated the status and versions but
  // left the mode cell as the discovery list first had it.
  let mode = 8;
  const row = await open(page, () => status('idle', { mode, mode_name: mode === 8 ? 'remote' : 'player' }));
  await expect(row).toContainText('Remote');
  mode = 2;
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.locator('#refreshStatsButton').click();
  await polled;
  await expect(row).toContainText('Player', { timeout: 15_000 });
});
