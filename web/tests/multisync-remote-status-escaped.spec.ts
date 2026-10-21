import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// More strings the MultiSync table takes from other systems' status, which
// multisync-remote-strings-escaped.spec.ts doesn't reach: a remote FPP's
// status name and elapsed time, its interfaces' Wi-Fi fields, the addresses it
// lists for itself and its disk names (in an HTML tooltip's markup), and a Falcon's
// status.  Anything on the LAN can answer as one of these, so each must reach
// the page as text.  The systems list and the status polls are answered by
// the test, as in multisync.spec.ts.
//
// Regression: dd65d5457.  Each of these went into the table (or the tooltip)
// as markup.

const INJECTED = (n: string) => `<u class=fpptestsinj>${n}</u>`;
// Closes the attribute it lands in, if it isn't escaped.
const ATTR = (n: string) => `"><u class=fpptestsinj>${n}</u><i x="`;
const REMOTE = '192.168.0.21';
const FV3 = '192.168.0.23';
const FV4 = '192.168.0.24';

function system(address: string, hostname: string, typeId: number, local = 0) {
  const fpp = typeId < 0x80;
  return {
    address, hostname, local, fppMode: fpp ? 2 : 1, fppModeString: fpp ? 'player' : 'bridge',
    typeId, type: fpp ? 'Raspberry Pi 4' : 'Falcon', model: fpp ? 'Raspberry Pi 4 Model B' : 'F16',
    version: fpp ? '10.x-master-1-gaaa1111bb' : '2.0', majorVersion: fpp ? 10 : 2, minorVersion: 0,
    uuid: fpp ? `M1-fpptests-${hostname}` : '', channelRanges: '', multiSyncCapable: fpp ? 1 : 0,
    multisync: false, lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const SYSTEMS = {
  systems: [
    system('192.168.0.13', 'FPPTESTLOCAL', 13, 1),
    system(REMOTE, 'FPPTESTREMOTE', 13),
    system(FV3, 'FPPTESTFV3', 0x80),
    system(FV4, 'FPPTESTFV4', 0x88),
  ],
};

const FALCON_V3 = { [FV3]: { u: INJECTED('fv3up'), v1: INJECTED('fv3v1'), v2: INJECTED('fv3v2') } };
const FALCON_V4 = {
  [FV4]: { status_name: INJECTED('fv4status'), P: { BS: 60, T1: 300, T2: 300, V1: 120, V2: 120, TS: 0, U: 100, BR: 48 } },
};

async function openMultisync(page: Page, remoteStatus: object) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => {
    const url = route.request().url();
    if (url.includes('type=FV3')) return route.fulfill({ json: FALCON_V3 });
    if (url.includes('type=FV4')) return route.fulfill({ json: FALCON_V4 });
    return route.fulfill({ json: { [REMOTE]: { warnings: [], rebootFlag: 0, restartFlag: 0, ...remoteStatus } } });
  });
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(4, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' });
}

test('a status name the page does not know is shown as text', async ({ page }) => {
  const row = await openMultisync(page, { status_name: INJECTED('status'), mode: 2, mode_name: 'player' });
  // The control: the poll's answer was drawn.
  await expect(row).toContainText('status');
  await expect(page.locator('#fppSystemsTable .fpptestsinj')).toHaveCount(0);
  await expect(row).toContainText(INJECTED('status'));
});

test('a playing remote\'s elapsed time, Wi-Fi fields, addresses and disk names are shown as text', async ({ page }) => {
  const row = await openMultisync(page, {
    status_name: 'playing', mode: 2, mode_name: 'player', current_sequence: 'Show.fseq', current_song: '',
    time_elapsed: INJECTED('elapsed'),
    wifi: [{ interface: 'wlan0', link: 50 }],
    interfaces: [{
      ifname: 'wlan0', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: REMOTE }],
      wifi: { interface: 'wlan0', link: 50, pct: ATTR('pct'), level: ATTR('level'), unit: 'dBm', desc: ATTR('desc') },
    }],
    advancedView: {
      Platform: 'Raspberry Pi', Variant: 'Pi 4', SubPlatform: 'Raspberry Pi 4 Model B', backgroundColor: '',
      Utilization: { CPU: 1, Memory: 2, Uptime: 86400000, Disk: { [INJECTED('disk')]: { Free: 1024, Total: 2048 } } },
      IPs: [REMOTE, INJECTED('ip')],
    },
  });
  await expect(row).toContainText('Show.fseq');
  await expect(row.locator('.wifi-icon')).toHaveCount(1);
  await expect(page.locator('#fppSystemsTable .fpptestsinj')).toHaveCount(0);
  await expect(row).toContainText(INJECTED('elapsed'));
  await expect(row).toContainText(INJECTED('ip'));

  // The uptime cell's "..." carries an HTML tooltip in its title: once the
  // browser has decoded the attribute, the disk name must still be escaped
  // markup, or the tooltip renders it.  Read from the attribute rather than by
  // hovering: each poller redraws the table, so whether the cell under the
  // mouse has a tooltip attached yet is a race.
  const tipMarkup = await row.locator('span[data-bs-html="true"]', { hasText: '...' }).first().evaluate((el) =>
    el.getAttribute('title') ?? el.getAttribute('data-bs-original-title') ?? el.getAttribute('data-bs-tooltip-title') ?? '');
  expect(tipMarkup).toContain('Disk Usage');
  expect(tipMarkup).toContain('&lt;u class=fpptestsinj&gt;disk&lt;/u&gt;');
  expect(tipMarkup).not.toContain(INJECTED('disk'));
});

test('a Falcon\'s status is shown as text', async ({ page }) => {
  await openMultisync(page, { status_name: 'idle', mode: 2, mode_name: 'player' });
  const v3 = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV3' });
  const v4 = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTFV4' });
  await expect(v3).toContainText('fv3up');
  await expect(v4).toContainText('fv4status');
  await expect(page.locator('#fppSystemsTable .fpptestsinj')).toHaveCount(0);
  for (const n of ['fv3up', 'fv3v1', 'fv3v2']) await expect(v3).toContainText(INJECTED(n));
  await expect(v4).toContainText(INJECTED('fv4status'));
});
