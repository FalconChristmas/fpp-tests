import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// What the MultiSync table's Utilization column (and the address beside it)
// shows from a remote's status: a Falcon's temperature in the units the UI is
// set to, and the signal of a remote that reports a lone rssi.  The systems
// list and the status polls are answered by the test, as in multisync.spec.ts;
// the units are this player's real temperatureInF setting.

test.skip(!container, 'sets this player\'s temperatureInF setting');

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';
const FV4 = '192.168.0.24';

function system(address: string, hostname: string, typeId: number, local = 0) {
  const fpp = typeId < 0x80;
  return {
    address, hostname, local, fppMode: fpp ? (local ? 2 : 8) : 1, fppModeString: fpp ? (local ? 'player' : 'remote') : 'bridge',
    typeId, type: fpp ? 'Raspberry Pi 4' : 'Falcon', model: fpp ? 'Raspberry Pi 4 Model B' : 'F16V4',
    version: fpp ? '10.x-master-1-gaaa1111bb' : '2.0', majorVersion: fpp ? 10 : 2, minorVersion: 0,
    uuid: fpp ? `M1-fpptests-${hostname}` : '', channelRanges: '', multiSyncCapable: fpp ? 1 : 0,
    multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

// 30.0 C on both sensors, against a 60 C threshold.
const FALCON_V4 = { [FV4]: { status_name: 'idle', P: { BS: 60, T1: 300, T2: 300, V1: 120, V2: 120, TS: 0, U: 100, BR: 16 } } };

// A remote whose status gives one rssi for itself and no interface list.
const RSSI_REMOTE = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  advancedView: { Platform: 'Raspberry Pi', rssi: -70, Utilization: { CPU: 3, Memory: 40, MemoryFree: 102400 } },
};

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system(LOCAL, 'FPPTESTLOCAL', 13, 1), system(REMOTE, 'FPPTESTREMOTE', 13), system(FV4, 'FPPTESTFV4', 0x88),
  ] } }));
  await page.route('**/api/system/status?**', (route) => {
    if (route.request().url().includes('type=FV4')) return route.fulfill({ json: FALCON_V4 });
    return route.fulfill({ json: { [REMOTE]: RSSI_REMOTE } });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

const setUnits = (page: Page, f: '0' | '1') =>
  page.request.put('/api/settings/temperatureInF', { data: f, headers: { 'Content-Type': 'text/plain' } });

test.afterEach(async ({ page }) => {
  await setUnits(page, '0');
});

test("a Falcon's temperature is shown in Fahrenheit when the UI is set to it", async ({ page }) => {
  // Regression: 68aa36c97.  It was always shown in Celsius.
  expect((await setUnits(page, '1')).ok()).toBe(true);
  await openMultisync(page);
  const falcon = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV4' });
  await expect(falcon).toContainText('TEMP: 86F');
  await expect(falcon).not.toContainText('30C');
});

test("a Falcon's temperature is shown in Celsius otherwise", async ({ page }) => {
  // The control for the test above: the same answer, the default units.
  expect((await setUnits(page, '0')).ok()).toBe(true);
  await openMultisync(page);
  await expect(page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV4' })).toContainText('TEMP: 30C');
});

test("a remote's lone rssi is a wifi icon by its address, not a line under Utilization", async ({ page }) => {
  // Feature: 07d92ea5b.  The signal was an "RSSI: -70dBm / 60%" line in the
  // Utilization column, and free memory read "Free Mem: 100K".
  await openMultisync(page);
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' });
  const icon = row.locator('.wifi-icon');
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveClass(/\bwifi-good\b/);
  // The address cell holds it; SetupToolTips() moves its title into the tooltip.
  await expect(row.locator('td', { has: page.locator(`a[data-ip="${REMOTE}"]`) }).locator('.wifi-icon')).toHaveCount(1);
  expect(await icon.evaluate((e) => e.getAttribute('title') || e.getAttribute('data-bs-tooltip-title'))).toBe('60% -70dBm');
  await expect(row).not.toContainText('RSSI');
  await expect(row).toContainText('Mem: 100K Free');
});
