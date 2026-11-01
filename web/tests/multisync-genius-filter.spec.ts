import { test, expect } from './fixtures';

// The Platform filter on the MultiSync page has a Genius entry that keeps only
// the Genius controllers.

const LOCAL = '192.168.0.13';
const GENIUS = '192.168.0.31';

function system(address: string, hostname: string, uuid: string, typeId: number, type: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId, type, model: type,
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test('the Platform filter\'s Genius entry keeps the Genius controllers and no other row', async ({ page }) => {
  // Feature: cb701328b.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 13, 'Raspberry Pi 4', 1),
    system(GENIUS, 'fpptests-genius', 'MAC:246F28AABB02', 0xa0, 'Genius'),
  ] } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  const rows = page.locator('#fppSystems tr.systemRow');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });

  const select = page.locator('#fppSystemsTable thead select').filter({ has: page.locator('option[value="Genius"]') });
  await select.selectOption({ value: 'Genius' });
  await expect(page.locator('tr.systemRow', { hasText: 'fpptests-genius' })).toBeVisible();
  await expect(page.locator('tr.systemRow', { hasText: 'FPPTESTLOCAL' })).not.toBeVisible();
});
