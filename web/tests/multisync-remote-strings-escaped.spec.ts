import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Strings the MultiSync page shows for other systems come from those systems:
// a remote FPP's status (what it is playing, its platform, branch, OS, host
// description, warnings) and a non-FPP controller's version from its ping.
// Anything on the LAN can answer as one, so each of these has to reach the
// page as text.  The systems list and the remote's status are answered by
// the test, as in multisync.spec.ts.
//
// INJECTED(n) is markup Bootstrap's tooltip sanitizer also lets through, so
// one marker class shows an injection in the table and in a tooltip alike.

const INJECTED = (n: string) => `<u class=fpptestsinj>${n}</u>`;
const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';
const OTHER = '192.168.0.22';

const SYSTEMS = {
  systems: [
    {
      address: LOCAL, hostname: 'FPPTESTLOCAL', local: 1, fppMode: 2, fppModeString: 'player',
      typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B Rev 1.1',
      version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
      uuid: 'M1-fpptests-local', channelRanges: '0-7', multiSyncCapable: 1, multisync: false,
      lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    },
    {
      address: REMOTE, hostname: 'FPPTESTREMOTE', local: 0, fppMode: 2, fppModeString: 'player',
      typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B Rev 1.1',
      version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
      uuid: 'M1-fpptests-remote', channelRanges: '0-7', multiSyncCapable: 1, multisync: false,
      lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    },
    {
      // typeId 0: never polled, so the version from its ping is all it shows
      address: OTHER, hostname: 'FPPTESTOTHER', local: 0, fppMode: 1, fppModeString: 'bridge',
      typeId: 0, type: 'Unknown System Type', model: 'Unknown',
      version: INJECTED('ver'), majorVersion: 0, minorVersion: 0,
      uuid: '', channelRanges: '', multiSyncCapable: 0, multisync: false,
      lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    },
  ],
};

const WARNING =
  '<script>window.__fppTestsWarnScript=1</script>Remote <b>warned</b> ' +
  '<img src=x onerror=window.__fppTestsWarnImg=1> ' +
  '<a href="javascript:window.__fppTestsWarnJs=1">bad link</a> ' +
  '<a href="crashreports.php">report</a>';

function remoteStatus() {
  return {
    [REMOTE]: {
      status_name: 'playing', mode: 2, mode_name: 'player',
      current_sequence: INJECTED('seq'), current_song: INJECTED('song'), time_elapsed: '00:10',
      rebootFlag: 0, restartFlag: 0, warnings: [WARNING], pluginHeaderIndicators: [],
      channelOutputsEnabled: true, channelInputsEnabled: false,
      interfaces: [{ ifname: 'eth0', flags: ['UP'], operstate: 'UP', addr_info: [{ family: 'inet', local: REMOTE }] }],
      advancedView: {
        Platform: 'Raspberry Pi', Variant: 'Pi 4',
        SubPlatform: INJECTED('subplatform'), backgroundColor: '',
        Branch: INJECTED('branch'), LocalGitVersion: 'aaa1111bb', RemoteGitVersion: 'aaa1111bb',
        OSVersion: INJECTED('os'), HostDescription: INJECTED('desc'),
        Utilization: { CPU: 1, Memory: 2, Uptime: '1 day', Disk: { Media: { Free: 1, Total: 2 } } },
        IPs: [REMOTE],
      },
    },
  };
}

async function openMultisync(page: Page) {
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [{ host: REMOTE, description: '' }] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: remoteStatus() }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const polled = page.waitForResponse((r) => r.url().includes('/api/system/status?type=FPP'));
  await page.goto('/multisync.php');
  await page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' }).waitFor({ timeout: 15_000 });
  await polled;
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' });
  // The control: the poll's answer was drawn before anything is checked.
  await expect(row).toContainText('Playing Sequence');
  return row;
}

test('a remote\'s status fields are shown as text', async ({ page }) => {
  // Regression: 7ebf6493f.  The sequence and media names, platform's model,
  // branch, OS version and host description from a remote's status went into
  // the table as markup.
  const row = await openMultisync(page);
  await expect(row).toContainText(INJECTED('seq'));
  await expect(page.locator('#fppSystemsTable .fpptestsinj')).toHaveCount(0);
  await expect(row).toContainText(INJECTED('subplatform'));
  await expect(row).toContainText(INJECTED('os'));
  await expect(row).toContainText(INJECTED('desc'));
});

test('a non-FPP system\'s version and a remote\'s warnings are made safe', async ({ page }) => {
  // Regression: b42c189d4.  A non-FPP system's version went into its cell
  // unescaped, and a remote's warnings were inserted as they came: a
  // <script> ran (jQuery .html() runs them), as did an onerror handler and a
  // javascript: link.  Now only text, a few formatting tags and links
  // survive, and a relative link points back at the remote, through the
  // proxy for a proxied one.
  await openMultisync(page);
  const other = page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTOTHER' });
  await expect(other).toContainText(INJECTED('ver'));
  await expect(other.locator('.fpptestsinj')).toHaveCount(0);

  const rowId = await page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTREMOTE' }).getAttribute('id');
  const cell = page.locator(`#${rowId}_warningCell`);
  await expect(cell).toContainText('warned');
  await expect(cell.locator('b')).toHaveText('warned');
  await expect(cell.locator('script, img')).toHaveCount(0);
  await expect(cell.locator('a', { hasText: 'bad link' })).toHaveCount(0);
  await expect(cell).toContainText('bad link');
  await expect(cell.locator('a', { hasText: 'report' })).toHaveAttribute('href', `proxy/${REMOTE}/crashreports.php`);
  const flags = await page.evaluate(() => [(window as any).__fppTestsWarnScript, (window as any).__fppTestsWarnImg]);
  expect(flags).toEqual([undefined, undefined]);
});

test('the play icon\'s tooltip shows the remote\'s file names as text', async ({ page }) => {
  // Regression: c283bef7b.  The tooltip renders as HTML and its markup rides
  // in data-bs-title; the names were escaped once, which the attribute parse
  // undoes, so the raw name reached the tooltip and its markup rendered.
  const row = await openMultisync(page);
  await row.locator('.ms-play-tip').hover();
  const tip = page.locator('.tooltip .tooltip-inner', { hasText: 'Media:' }).first();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(`Sequence: ${INJECTED('seq')}`);
  await expect(tip).toContainText(`Media: ${INJECTED('song')}`);
  await expect(tip.locator('.fpptestsinj')).toHaveCount(0);
  await expect(tip.locator('br')).toHaveCount(1);
});

test('the header\'s player badge tooltip shows the file names as text', async ({ page }) => {
  // Regression: c283bef7b (the same double decode, in fpp.js's header badge).
  // The status WebSocket is refused, so the badge is drawn from the polled
  // status, whose names the test sets.
  await page.routeWebSocket(/fppdws/, (ws) => ws.close());
  await page.route(/\/api\/system\/status$/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    Object.assign(json, {
      status_name: 'playing', current_sequence: INJECTED('hseq'), current_song: INJECTED('hsong'),
      current_playlist: { playlist: '', generated: false },
    });
    return route.fulfill({ response, json });
  });
  await page.goto('/index.php');
  const badge = page.locator('#header_player > span[data-bs-toggle="tooltip"]');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await badge.hover();
  const tip = page.locator('.tooltip .tooltip-inner');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(INJECTED('hseq'));
  await expect(tip).toContainText(INJECTED('hsong'));
  await expect(tip.locator('.fpptestsinj')).toHaveCount(0);
});
