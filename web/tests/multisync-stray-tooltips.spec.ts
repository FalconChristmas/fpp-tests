import { test, expect } from './fixtures';

// A tooltip whose element leaves the MultiSync table while it is showing
// gets no mouseleave, so nothing in Bootstrap or fpp.js's SetupToolTips()
// hides it.  The page sweeps up every tooltip the mouse is not over every
// 3 s.  The systems list and the status polls are answered by the test, as
// in multisync.spec.ts.

const base = {
  fppMode: 8, fppModeString: 'remote', typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, channelRanges: '',
  multiSyncCapable: 1, multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
};

const SYSTEMS = {
  systems: [
    { ...base, address: '192.168.0.13', hostname: 'FPPTESTLOCAL', local: 1, fppMode: 2, fppModeString: 'player', uuid: 'M1-fpptests-local' },
    { ...base, address: '192.168.0.21', hostname: 'FPPTESTREMOTE', local: 0, uuid: 'M1-fpptests-remote' },
  ],
};

// The Utilization cell's uptime is a <span title="since ...">.
const STATUS = {
  '192.168.0.21': {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Utilization: { CPU: 5, Memory: 20, Uptime: 3_600_000 } },
  },
};

test('a tooltip left behind by its element is swept away', async ({ page }) => {
  // Feature: 35592d288.  Such a tooltip stayed over the table until the page
  // was reloaded.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: STATUS }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' });
  const uptime = row.locator('span[data-bs-tooltip-title^="since"]');
  await expect(uptime).toHaveCount(1, { timeout: 15_000 });

  await uptime.hover();
  const tip = page.locator('.tooltip');
  await expect(tip).toBeVisible();
  // The element goes from under the mouse, as when a redraw drops its row
  // (no mouseleave, no dispose), and the mouse moves off.
  await uptime.evaluate((el) => el.remove());
  await page.mouse.move(5, 5);
  await expect(tip).toHaveCount(0, { timeout: 4_500 });
});
