import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The wifi icon in a MultiSync row's IP Address cell: it goes after an
// address the remote has on an active wireless interface, as its status
// answer (interfaces[].wifi) says, and nowhere else.  The systems list and
// the status answers are the test's, as in multisync.spec.ts.

const LOCAL = '192.168.0.13';
const WIRED = '192.168.0.21';
const WIRELESS = '192.168.0.121';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const WIFI = { interface: 'wlan0', link: 60, level: -55, pct: 90, unit: 'dBm', noise: 0, desc: 'excellent' };

// The remote's answer: a wired and a wireless interface.
const DUAL_NIC = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  wifi: [WIFI],
  interfaces: [
    { ifname: 'eth0', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: WIRED, prefixlen: 24 }] },
    { ifname: 'wlan0', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: WIRELESS, prefixlen: 24 }], wifi: WIFI },
  ],
  advancedView: {
    Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', IPs: [WIRED, WIRELESS],
    Utilization: { CPU: 12, Memory: 34 },
  },
};

// What api/system/status answers for an address it gets no answer from
// (system.php's $default_return_json, status_name "unreachable").
const UNREACHABLE = {
  fppd: 'unknown', status: 'stopped', wifi: [], interfaces: [], status_name: 'unreachable',
  current_playlist: { playlist: '', type: '', index: '0', count: '0' },
  current_sequence: '', current_song: '', seconds_played: '0', seconds_remaining: '0', time_elapsed: '00:00', time_remaining: '00:00',
};

async function openMultisync(page: Page, addresses: string[], status: Record<string, unknown>) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), ...addresses.map((a) => system(a, 'fpptests-remote', 'M1-fpptests-remote'))] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: status }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
}

// The IP cell's markup, with each address and icon in order.
async function ipCellTokens(page: Page, row: ReturnType<Page['locator']>): Promise<string[]> {
  return row.locator('td').filter({ hasText: WIRED }).first().evaluate((td, ips) => {
    const html = td.innerHTML;
    const at: [number, string][] = [];
    for (const ip of ips) {
      const i = html.search(new RegExp(ip.replace(/\./g, '\\.') + '(?![0-9])'));
      if (i >= 0) at.push([i, ip]);
    }
    let i = -1;
    while ((i = html.indexOf('wifi-icon', i + 1)) !== -1) at.push([i, 'wifi']);
    return at.sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }, [WIRED, WIRELESS]);
}

test("a remote polled at its wired address gets no wifi icon there", async ({ page }) => {
  // Regression: 071f141c6 (#2639).  Any wifi the remote reported put the
  // icon after whichever address the row was polled at, so a dual-NIC
  // remote listed at its wired address showed a wifi icon on that one.
  // Without advancedView.IPs the row shows the wired address only.
  const status = { ...DUAL_NIC, advancedView: { ...DUAL_NIC.advancedView, IPs: undefined } };
  const row = await openMultisync(page, [WIRED], { [WIRED]: status });
  // The control: the status answer reached the row.
  await expect(row).toContainText('master', { timeout: 15_000 });
  await page.waitForTimeout(3000);
  expect(await ipCellTokens(page, row)).toEqual([WIRED]);
});

test("a remote answering only at its wired address gets the wifi icon after its wireless one", async ({ page }) => {
  // Regression: 6093170ee.  The icon went only after the polled address,
  // and only if that address was on the wireless interface; a remote that
  // answered at its wired address and not at its wireless one (a status
  // with no interfaces) showed no icon at all.
  const row = await openMultisync(page, [WIRED, WIRELESS], { [WIRED]: DUAL_NIC, [WIRELESS]: UNREACHABLE });
  await expect(row).toContainText('master', { timeout: 15_000 });
  await expect.poll(() => ipCellTokens(page, row), { timeout: 10_000 }).toEqual([WIRED, WIRELESS, 'wifi']);
});
