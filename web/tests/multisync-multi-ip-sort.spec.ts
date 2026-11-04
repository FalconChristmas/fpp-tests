import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A remote with more than one address is sorted by its first one.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const status = (ips: string[]) => ({
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  interfaces: ips.map((ip, i) => ({ ifname: `eth${i}`, flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: ip, prefixlen: 24 }] })),
  advancedView: { Platform: 'Raspberry Pi', Branch: 'master', LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', IPs: ips, Utilization: { CPU: 1, Memory: 2 } },
});

// "fpptests-m" answers at 10.0.0.50 and also at 10.0.0.3: sorted by its first
// address it belongs after 10.0.0.9, not before 10.0.0.5.
const REMOTES: [string, string, string[]][] = [
  ['10.0.0.50', 'fpptests-m', ['10.0.0.50', '10.0.0.3']],
  ['10.0.0.9', 'fpptests-a', ['10.0.0.9']],
  ['10.0.0.5', 'fpptests-b', ['10.0.0.5']],
];

test('a remote with two addresses sorts by its first address', async ({ page }: { page: Page }) => {
  // Regression: 19b7c3dcd.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('10.0.0.1', 'fpptests-local', 'M1-fpptests-local', 1),
    ...REMOTES.map(([ip, host]) => system(ip, host, `M1-${host}`)),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: Object.fromEntries(REMOTES.map(([ip, , ips]) => [ip, status(ips)])) }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status'));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(4, { timeout: 15_000 });
  await polled;
  await page.waitForTimeout(500);
  await page.locator('#fppSystemsTable thead th[data-field="ipaddress"] .sortable').click();
  const names = await page.locator('#fppSystems tr.systemRow').evaluateAll((rows) =>
    rows.map((r) => (r.querySelector('span[id^="fpp_"]')?.textContent ?? '').trim()));
  const want = ['fpptests-local', 'fpptests-b', 'fpptests-a', 'fpptests-m'];
  expect([JSON.stringify(want), JSON.stringify([...want].reverse())]).toContain(JSON.stringify(names));
});
