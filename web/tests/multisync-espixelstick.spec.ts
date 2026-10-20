import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// ESPixelStick rows on the MultiSync page.  The two firmware generations
// answer status differently: 3.x only over its WebSocket at /ws (which the
// page reaches through the player's /proxy/<ip>/ws), 4.x on FPP's own
// /api/system/status, in the same batch as the FPP systems.  The systems
// list and the status batch are answered by the test.

const LOCAL = '192.168.0.13';
const ESPS3 = '192.168.0.31';
const ESPS4 = '192.168.0.32';

function system(address: string, hostname: string, typeId: number, version: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 1, fppModeString: local ? 'player' : 'bridge',
    typeId, type: local ? 'Raspberry Pi 4' : 'ESPixelStick', model: local ? 'Raspberry Pi 4 Model B' : 'ESPixelStick',
    version, majorVersion: parseInt(version), minorVersion: 0, uuid: local ? 'M1-fpptests-local' : '',
    channelRanges: '', multiSyncCapable: local, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const SYSTEMS = {
  systems: [
    system(LOCAL, 'FPPTESTLOCAL', 13, '10.x-master-1-gaaa1111bb', 1),
    system(ESPS3, 'fpptests-esps3', 0xc3, '3.2'),
    system(ESPS4, 'fpptests-esps4', 0xc3, '4.1'),
  ],
};

// What a 4.x stick answers on /api/system/status: no OSVersion, since it
// doesn't run FPP's OS.
const ESPS4_STATUS = {
  status_name: 'idle', mode_name: 'bridge', mode: 1, warnings: [],
  advancedView: { Platform: 'ESPixelStick', Version: '4.1', Utilization: { Uptime: '1 day' } },
};

async function openMultisync(page: Page, statusRequests: string[], sockets: string[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => {
    statusRequests.push(decodeURIComponent(route.request().url()));
    return route.fulfill({ json: { [ESPS4]: ESPS4_STATUS } });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
}

test('each ESPixelStick generation is asked the way it can answer', async ({ page }) => {
  // Regression: c2175c947.  The generations were the wrong way round: 4.x
  // was polled over a WebSocket it no longer has and 3.x on an HTTP status
  // URL it never served, so neither ever reported.  A 4.x stick sends no
  // OSVersion, which showed as "OS: undefined".  Also covers 7a6786e8a: the
  // socket goes through the player's own /proxy/<ip>/ws, not straight at the
  // device (which CSP refuses).
  const statusRequests: string[] = [];
  const sockets: string[] = [];
  await openMultisync(page, statusRequests, sockets);
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
  await expect.poll(() => sockets.filter((u) => /\/ws$/.test(u)), { timeout: 10_000 })
    .toEqual([expect.stringContaining(`/proxy/${ESPS3}/ws`)]);
  const fppBatch = statusRequests.filter((u) => u.includes('type=FPP'));
  expect(fppBatch.some((u) => u.includes(`ip[]=${ESPS4}`)), fppBatch.join('\n')).toBe(true);
  expect(fppBatch.some((u) => u.includes(`ip[]=${ESPS3}`)), fppBatch.join('\n')).toBe(false);
  const row4 = page.locator('tr.systemRow', { hasText: 'fpptests-esps4' });
  await expect(row4).toContainText('Idle');
  await expect(row4).not.toContainText('undefined');
});
