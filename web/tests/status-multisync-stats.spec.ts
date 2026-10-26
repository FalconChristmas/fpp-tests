import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The status page of a player in Remote mode lists the MultiSync packets it
// has had from each player (api/fppd/multiSyncStats) in a table, and names
// the player it syncs to.  This player is in Player mode with no one sending
// it sync packets, so the test puts Remote mode in fppd's own status pushes
// and answers multiSyncStats itself, in the shape fppd's MultiSync::
// GetSyncStats() and MultiSyncStats::toJSON() give it.

const stats = (sourceIP: string, hostname: string, errors = 0) => ({
  sourceIP, hostname, lastReceiveTime: '2026-10-25 12:00:00',
  pktCommand: 0, pktSyncSeqOpen: 1, pktSyncSeqStart: 1, pktSyncSeqStop: 0, pktSyncSeqSync: 100,
  pktSyncMedOpen: 1, pktSyncMedStart: 1, pktSyncMedStop: 0, pktSyncMedSync: 100,
  pktBlank: 0, pktPing: 10, pktPlugin: 0, pktFPPCommand: 0, pktError: errors,
});

async function remoteStatusPage(page: Page, answer: object) {
  await page.routeWebSocket('**/fppdws', (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== 'string') return ws.send(message);
      try {
        const msg = JSON.parse(message);
        if (msg?.type === 'snapshot' && msg.data?.status) Object.assign(msg.data.status, { mode: 8, mode_name: 'remote' });
        return ws.send(JSON.stringify(msg));
      } catch {
        return ws.send(message);
      }
    });
  });
  await page.route('**/api/fppd/multiSyncStats**', (route) => route.fulfill({ json: answer }));
  await page.goto('/index.php');
  await expect(page.locator('#remoteModeInfo')).toBeVisible({ timeout: 15_000 });
  // The page's own first status was this player's, in Player mode, so it
  // asks for the stats when Update is pressed.
  await page.locator('#remoteModeInfo input[value="Update"]').click();
  return page.locator('#syncStatsTable tbody tr');
}

test("the stats answer this fppd gives has the fields the table reads", async ({ request }) => {
  // The control for the tests below: the real endpoint's shape.
  const real = await (await request.get('/api/fppd/multiSyncStats')).json();
  expect(Object.keys(real)).toEqual(expect.arrayContaining(['masterIP', 'masterHostname', 'systems']));
  for (const s of real.systems) {
    expect(Object.keys(s).sort()).toEqual(Object.keys(stats('x', 'y')).sort());
  }
});

test('the player being synced to is listed first, marked (Player)', async ({ page }) => {
  // Feature: dd51588c4.
  const rows = await remoteStatusPage(page, {
    masterIP: '192.0.2.10', masterHostname: 'show-player',
    systems: [stats('192.0.2.30', 'remote-b'), stats('192.0.2.10', 'show-player'), stats('192.0.2.20', 'remote-a')],
  });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('192.0.2.10');
  await expect(rows.nth(0)).toContainText('(Player)');
  await expect(rows.filter({ hasText: '(Player)' })).toHaveCount(1);
  await expect(page.locator('#syncMaster')).toContainText('192.0.2.10 (show-player)');
});

test('the stats table is a Bootstrap Table that sorts by a column', async ({ page }) => {
  // Feature: 9d5a8dbbc (index.php's tables from tablesorter to Bootstrap Table).
  const rows = await remoteStatusPage(page, {
    masterIP: '192.0.2.20', masterHostname: '',
    systems: [stats('192.0.2.30', ''), stats('192.0.2.20', ''), stats('192.0.2.10', '')],
  });
  await expect(rows).toHaveCount(3);
  await expect(page.locator('.bootstrap-table #syncStatsTable')).toHaveCount(1);
  const hosts = async () => (await rows.locator('td:first-child').allInnerTexts()).map((t) => t.replace(/\s.*/, ''));
  // The player being synced to first, the rest as fppd listed them.
  await expect.poll(hosts).toEqual(['192.0.2.20', '192.0.2.30', '192.0.2.10']);
  await page.locator('#syncStatsTable thead th[data-field="host"] .sortable').click();
  await expect.poll(hosts).toEqual(['192.0.2.10', '192.0.2.20', '192.0.2.30']);
});

test('an IPv6 player address links as http://[address]/', async ({ page }) => {
  // Regression: 09f92bf1f.  The link was built as 'http://' + address, so
  // an IPv6 one came out as http://fd00::10, which a browser can't open.
  await remoteStatusPage(page, {
    masterIP: 'fd00::10', masterHostname: 'v6-player',
    systems: [stats('fd00::10', 'v6-player')],
  });
  const link = page.locator('#syncMaster a');
  await expect(link).toHaveText('fd00::10');
  await expect(link).toHaveAttribute('href', 'http://[fd00::10]');
  // A browser makes a URL of it.
  expect(await link.evaluate((a) => (a as HTMLAnchorElement).hostname)).toBe('[fd00::10]');
});
