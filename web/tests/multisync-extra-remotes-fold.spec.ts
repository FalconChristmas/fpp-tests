import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// The MultiSync page keeps a unicast remote that has dropped out of the
// systems list by moving it from MultiSyncRemotes (the ticked boxes) into
// MultiSyncExtraRemotes (the typed-in list), so its sync is not lost while it
// is away.  fppd sends sync to every entry of both (ReloadSyncDestinations()).
// The systems list is answered by the test; the settings are the player's.

test.skip(!container, "changes the player's MultiSync settings");

const LOCAL = '192.168.0.13';
const put = (page: Page, name: string, value: string) =>
  page.request.put(`/api/settings/${name}`, { data: value, headers: { 'Content-Type': 'text/plain' } });
const get = async (page: Page, name: string) => (await (await page.request.get(`/api/settings/${name}`)).json()).value;

test.afterEach(async ({ page }) => {
  await put(page, 'MultiSyncRemotes', '');
  await put(page, 'MultiSyncExtraRemotes', '');
  await put(page, 'MultiSyncBroadcast', '0');
  await put(page, 'MultiSyncMulticast', '0');
  await put(page, 'MultiSyncEnabled', '0');
});

async function open(page: Page, remotes: string) {
  await put(page, 'MultiSyncEnabled', '1');
  await put(page, 'MultiSyncExtraRemotes', '');
  await put(page, 'MultiSyncRemotes', remotes);
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
}

test('a unicast remote that is not in the list is kept in the extra remotes', async ({ page }) => {
  await open(page, '192.168.0.99');
  // (An empty setting splits as one empty entry, kept as a leading comma;
  // fppd skips empty entries.)
  await expect.poll(async () => String(await get(page, 'MultiSyncExtraRemotes')).split(',').filter(Boolean))
    .toEqual(['192.168.0.99']);
});

// Older FPP kept Broadcast and Multicast in MultiSyncRemotes as the addresses
// 255.255.255.255 and 239.70.80.80.  They are never a system in the list, so
// the page moves them into MultiSyncExtraRemotes too, where no checkbox
// reaches them: unticking Broadcast afterwards leaves fppd sending sync to
// 255.255.255.255 for good. The page leaves those two addresses out of
// MultiSyncExtraRemotes.
test("an old settings file's broadcast and multicast entries are not made extra remotes", async ({ page }) => {
  await open(page, '255.255.255.255,239.70.80.80,192.168.0.99');
  // The page reads them as the two send methods.
  await expect(page.locator('#MultiSyncBroadcast')).toBeChecked();
  await expect.poll(() => get(page, 'MultiSyncExtraRemotes')).toContain('192.168.0.99');
  const extra = String(await get(page, 'MultiSyncExtraRemotes'));
  expect(extra.split(',')).not.toContain('255.255.255.255');
  expect(extra.split(',')).not.toContain('239.70.80.80');
});
