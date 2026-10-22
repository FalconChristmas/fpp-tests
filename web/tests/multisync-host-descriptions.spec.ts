import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The line under each device's name on the MultiSync page: a description
// filled in from what the device's own status says, when it says one.  And a
// WLED's name, which only its status carries.  The systems list and every
// status batch are answered by the test.

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';
const GENIUS = '192.168.0.41';
const BALDRICK = '192.168.0.42';
const WLED = '192.168.0.43';

function system(address: string, hostname: string, typeId: number, type: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 1, fppModeString: local ? 'player' : 'bridge',
    typeId, type, model: type, version: typeId < 128 ? '10.x-master-1-gaaa1111bb' : '1.0',
    majorVersion: typeId < 128 ? 10 : 1, minorVersion: 0, uuid: local ? 'M1-fpptests-local' : '',
    channelRanges: '', multiSyncCapable: local, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const SYSTEMS = {
  systems: [
    system(LOCAL, 'FPPTESTLOCAL', 13, 'Raspberry Pi 4', 1),
    system(REMOTE, 'FPPTESTREMOTE', 13, 'Raspberry Pi 4'),
    system(GENIUS, 'FPPTESTGENIUS', 0xa0, 'Genius'),
    system(BALDRICK, 'FPPTESTBALDRICK', 0xc4, 'Baldrick'),
    // Listed under its address: what discovery has before the name.
    system(WLED, WLED, 0xfb, 'WLED'),
  ],
};

// Each answers status without the field its description comes from.
const STATUS: Record<string, Record<string, unknown>> = {
  FPP: {
    [REMOTE]: {
      status_name: 'idle', mode_name: 'player', mode: 2, warnings: [],
      advancedView: { Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Utilization: { CPU: 12, Memory: 34 } },
    },
  },
  Genius: { [GENIUS]: { status_name: 'idle', system: { uptime_seconds: 100 } } },
  Baldrick: { [BALDRICK]: { uptime: 100 } },
  WLED: { [WLED]: { name: 'fpptests-wled-porch', status_name: 'idle', uptime: 100, wifi: { rssi: -60, signal: 80 } } },
};

async function openMultisync(page: Page, asked: string[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => {
    const type = new URL(route.request().url()).searchParams.get('type') || '';
    asked.push(type);
    return route.fulfill({ json: STATUS[type] || {} });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(5, { timeout: 15_000 });
}

test('a device whose status gives no description shows none, not "undefined"', async ({ page }) => {
  // Regression: 97c042555.  An FPP remote's status with no HostDescription
  // (undefined !== "" passed), a Genius with no friendly_name and a Baldrick
  // with neither board_model nor hostname each wrote "undefined" under the
  // device's name.
  const asked: string[] = [];
  await openMultisync(page, asked);
  await expect.poll(() => ['FPP', 'Genius', 'Baldrick'].filter((t) => asked.includes(t)), { timeout: 10_000 })
    .toEqual(['FPP', 'Genius', 'Baldrick']);
  for (const [name, shown] of [['FPPTESTREMOTE', 'CPU:'], ['FPPTESTGENIUS', 'UP:'], ['FPPTESTBALDRICK', 'UP:']]) {
    const row = page.locator('#fppSystems tr.systemRow', { hasText: name });
    // The status was taken in: the row shows what it reported.
    await expect(row).toContainText(shown);
    await expect(row.locator('.hostDescriptionSM')).toHaveText('');
    await expect(row).not.toContainText('undefined');
    await expect(row).not.toContainText('null');
  }
});

test('a WLED is shown by the name its status gives, linked to the device', async ({ page }) => {
  // Regression: 68bafbaba.  A WLED was shown under the address discovery
  // listed it by, with no link: the name in its status was never used, and
  // a name equal to the address was taken for this player's own.
  await openMultisync(page, []);
  const row = page.locator('#fppSystems tr.systemRow').filter({ has: page.locator(`#fpp_${WLED.replace(/\./g, '_')}_hostname`) });
  const link = row.locator(`#fpp_${WLED.replace(/\./g, '_')}_hostname a`);
  await expect(link).toHaveText('fpptests-wled-porch', { timeout: 10_000 });
  expect(await link.getAttribute('href')).toContain(WLED);
});
