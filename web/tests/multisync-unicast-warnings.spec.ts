import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// A remote ticked for unicast sync while sync already goes to every remote
// (multicast or broadcast) gets a warning row under it on the MultiSync page.
// The systems list is answered by the test; the settings are the player's own.

test.skip(!container, 'changes the player\'s MultiSync settings');

const LOCAL = '192.0.2.21';
const REMOTE = '192.0.2.22';
const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });

function system(address: string, hostname: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: `M1-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncBroadcast', '0');
  await put(page, 'MultiSyncMulticast', '0');
  await put(page, 'MultiSyncUnicast', '1');
  await put(page, 'MultiSyncRemotes', '');
  await put(page, 'MultiSyncEnabled', '0');
});

test('a remote ticked for unicast while multicast is on is warned about, and not once multicast is off', async ({ page }) => {
  // Regression: f2165ef07 ("Add warnings for crazy Multisync/broadcast
  // selections", #952).  Nothing said that unicasting to a remote that
  // multicast or broadcast already reaches sends it every sync packet twice.
  await put(page, 'MultiSyncEnabled', '1');
  await put(page, 'MultiSyncUnicast', '0');
  await put(page, 'MultiSyncBroadcast', '0');
  await put(page, 'MultiSyncMulticast', '1');
  await put(page, 'MultiSyncRemotes', REMOTE);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system(LOCAL, 'fpptests-local', 1), system(REMOTE, 'fpptests-remote'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(`input.syncCheckbox[name="${REMOTE}"]`)).toBeChecked();
  const warning = page.locator('.warning-row .multisync-warning');
  await expect(warning).toHaveCount(1, { timeout: 10_000 });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(`Having Unicast checked when Multicast is enabled (view options below) is discouraged: ${REMOTE}`);

  // The control: with multicast off (and nothing else sending to all) it goes.
  await page.locator('.fppSystemsUiSettingsToggle').click();
  await page.locator('#MultiSyncMulticast').uncheck();
  await expect(warning).toHaveCount(0);
});
