import { test, expect } from './fixtures';

// A device listed at two addresses -- here a remote FPP's hotspot address and
// its LAN address, with one UUID -- is one row on the MultiSync page, and its
// status is polled on the address that shares a subnet with this player,
// whichever order the list gives them in.  The list and the polls are
// answered by the test.

const base = {
  fppMode: 2, fppModeString: 'player', typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000, channelRanges: '',
  multiSyncCapable: 1, multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
};

const SYSTEMS = {
  systems: [
    { ...base, address: '192.168.0.13', hostname: 'FPPTESTLOCAL', local: 1, uuid: 'M1-fpptests-local' },
    { ...base, address: '192.168.8.1', hostname: 'FPPTESTREMOTE', local: 0, uuid: 'M1-fpptests-remote' },
    { ...base, address: '192.168.0.40', hostname: 'FPPTESTREMOTE', local: 0, uuid: 'M1-fpptests-remote' },
  ],
};

test('a device with a hotspot address is polled on the one this player can reach', async ({ page }) => {
  // Feature: 3fd78ebdd.  The row's first address was the one polled, though
  // a hotspot address (192.168.8.x) is reachable only from the hotspot.
  const polled: string[] = [];
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => {
    const url = decodeURIComponent(route.request().url());
    if (url.includes('type=FPP')) polled.push(url);
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  const row = page.locator('tr.systemRow', { hasText: 'FPPTESTREMOTE' });
  await expect(row).toContainText('192.168.8.1');
  await expect(row).toContainText('192.168.0.40');
  await expect.poll(() => polled.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(polled.some((u) => u.includes('ip[]=192.168.0.40')), polled.join('\n')).toBe(true);
  expect(polled.some((u) => u.includes('ip[]=192.168.8.1')), polled.join('\n')).toBe(false);
});
