import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// Multicast, Broadcast and Unicast-to-all-known are three ways to send sync
// to ALL remotes, so turning one on turns the others off.  The systems list is
// answered by the test; the settings are the player's own.

test.skip(!container, 'changes the player\'s MultiSync settings');

const LOCAL = '192.168.0.13';
const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncBroadcast', '0');
  await put(page, 'MultiSyncMulticast', '0');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncEnabled', '0');
});

async function open(page: Page, start: Record<string, string>) {
  await put(page, 'MultiSyncEnabled', '1');
  for (const [k, v] of Object.entries(start)) await put(page, k, v);
  await put(page, 'MultiSyncRemotes', '');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [{
    address: LOCAL, hostname: 'FPPTESTLOCAL', local: 1, fppMode: 2, fppModeString: 'player',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: 'M1-fpptests-local',
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '' }] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('.fppSystemsUiSettingsToggle').click();
}

for (const [on, others] of [
  ['MultiSyncMulticast', ['MultiSyncBroadcast', 'MultiSyncUnicast']],
  ['MultiSyncBroadcast', ['MultiSyncMulticast', 'MultiSyncUnicast']],
  ['MultiSyncUnicast', ['MultiSyncMulticast', 'MultiSyncBroadcast']],
] as const) {
  test(`ticking ${on} unticks the other two send-to-all methods`, async ({ page }) => {
    // Regression: c8ede32b9 (Broadcast and Multicast mutually exclusive) and
    // f2165ef07 (warnings for odd sync selections).
    const start: Record<string, string> = { MultiSyncBroadcast: '0', MultiSyncMulticast: '0', MultiSyncUnicast: '0' };
    start[others[0]] = '1';
    await open(page, start);
    await expect(page.locator(`#${others[0]}`)).toBeChecked();
    await page.locator(`#${on}`).check();
    await expect(page.locator(`#${on}`)).toBeChecked();
    for (const o of others) await expect(page.locator(`#${o}`)).not.toBeChecked();
  });
}
