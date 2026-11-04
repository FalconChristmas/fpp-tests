import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A MultiSync row is refreshed on its own once an action on that remote
// (an upgrade, a branch change, a restart) is done: getFPPSystemStatus() with
// that one address.  The systems list and the status answers are the
// test's, as in multisync.spec.ts.

const LOCAL = '192.168.0.13';
const A = '192.168.0.21';
const B = '192.168.0.22';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const idle = (ip: string) => ({
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [], wifi: [], interfaces: [],
  current_playlist: { playlist: '', type: '', index: '0', count: '0' },
  advancedView: { Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', IPs: [ip], Utilization: { CPU: 12, Memory: 34 } },
});

// Each status request's addresses, in order.
async function openMultisync(page: Page, polls: string[][]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
      system(A, 'fpptests-remote-a', 'M1-fpptests-a'), system(B, 'fpptests-remote-b', 'M1-fpptests-b')] },
  }));
  await page.route('**/api/system/status?**', (route) => {
    const ips = new URL(route.request().url()).searchParams.getAll('ip[]');
    if (ips.length) polls.push(ips);
    return route.fulfill({ json: Object.fromEntries(ips.map((ip) => [ip, idle(ip)])) });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

test('refreshing one remote asks for it, and the auto refresh of every remote goes on', async ({ page, request }) => {
  // Regression: 6d1fae935 ("Fix refresh after upgrade script is done").
  // Given one address, not a list, getFPPSystemStatus() built an empty query
  // and the row was never refreshed.
  // Regression: dbb2a4352 ("Don't stop refreshing all systems just because
  // we refreshed a single one").  The single refresh rescheduled the auto
  // refresh with its own one address, so from then on only that remote was
  // polled and the others' rows went stale.
  test.setTimeout(90_000);
  const polls: string[][] = [];
  await request.put('/api/settings/MultiSyncRefreshStatus', { data: '1' });
  try {
    await openMultisync(page, polls);
    const all = (p: string[]) => p.includes(A) && p.includes(B);
    await expect.poll(() => polls.filter(all).length, { timeout: 20_000, message: 'auto refreshes of every remote' }).toBeGreaterThanOrEqual(2);

    const from = polls.length;
    await page.evaluate((ip) => (window as any).getFPPSystemStatus(ip, true), A);
    await expect.poll(() => polls.slice(from).some((p) => p.length === 1 && p[0] === A),
      { timeout: 10_000, message: 'a status request for the one remote' }).toBe(true);

    const after = polls.length;
    await expect.poll(() => polls.slice(after).filter(all).length,
      { timeout: 20_000, message: 'auto refreshes of every remote after the single refresh' }).toBeGreaterThanOrEqual(3);
  } finally {
    await request.put('/api/settings/MultiSyncRefreshStatus', { data: '0' });
  }
});
