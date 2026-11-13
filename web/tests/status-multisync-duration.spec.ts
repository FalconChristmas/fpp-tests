import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Last Rcvd column of the MultiSync statistics (ShowMultiSyncStats and
// niceDuration in fpp.js) says how long ago a player was heard from, the
// time fppd gave in the cell's title.

const stat = (lastReceiveTime: string, sourceIP: string) => ({
  sourceIP, hostname: '', lastReceiveTime,
  pktCommand: 0, pktSyncSeqOpen: 1, pktSyncSeqStart: 1, pktSyncSeqStop: 0, pktSyncSeqSync: 100,
  pktSyncMedOpen: 1, pktSyncMedStart: 1, pktSyncMedStop: 0, pktSyncMedSync: 100,
  pktBlank: 0, pktPing: 10, pktPlugin: 0, pktFPPCommand: 0, pktError: 0,
});
const local = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// The status page of a player in Remote mode, as status-multisync-stats.spec.ts
// puts it, with multiSyncStats answered here.
async function lastRcvd(page: Page, times: string[]) {
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
  await page.route('**/api/fppd/multiSyncStats**', (route) => route.fulfill({
    json: { masterIP: '', masterHostname: '', systems: times.map((t, i) => stat(t, `192.0.2.${30 + i}`)) } }));
  await page.goto('/index.php');
  await expect(page.locator('#remoteModeInfo')).toBeVisible({ timeout: 15_000 });
  await page.locator('#remoteModeInfo input[value="Update"]').click();
}

test('Last Rcvd shows how long ago, with the time fppd gave in the title', async ({ page }) => {
  // Feature: 63975a371.  The column listed the raw time; a long list of
  // players is easier to read as "2 min" than as a column of timestamps.
  const now = Date.now();
  const stamps = [new Date(now - 90_000), new Date(now - 2 * 3600_000 - 60_000), new Date(now - 20_000)].map(local);
  await lastRcvd(page, stamps);
  const cells = page.locator('#syncStatsTable tbody tr td:nth-child(2) span');
  await expect(cells).toHaveCount(3);
  await expect(cells.nth(0)).toHaveText(/^[12] min$/);
  await expect(cells.nth(1)).toHaveText('2 hours');
  await expect(cells.nth(2)).toHaveText(/^\d+ sec$/);
  for (let i = 0; i < 3; i++) await expect(cells.nth(i)).toHaveAttribute('title', stamps[i]);
});

test('Last Rcvd never shows a negative duration', async ({ page }) => {
  // Regression: cdfb5d906.  A player whose clock ran ahead of this one (or a
  // time of "now") came out as "-3000 ms" in the column.
  await lastRcvd(page, [local(new Date(Date.now() + 5 * 60_000))]);
  const cell = page.locator('#syncStatsTable tbody tr td:nth-child(2) span');
  await expect(cell).toHaveCount(1);
  await expect(cell).toHaveText('< 1 min');
  const nice = await page.evaluate(() => [0, -5000, 500, 59_000].map((t) => (window as any).niceDuration(t)));
  expect(nice).toEqual(['&lt; 1 min', '&lt; 1 min', '500 ms', '59 sec']);
});

// fppd writes lastReceiveTime in the player's own zone, with no zone in it
// (MultiSync.cpp, localtime_r).  The page reads it with new Date() in the
// browser's zone, so a browser in another zone is off by the difference.
// The tests above build their stamps in this host's zone, which is the
// browser's too.
test.describe('from a browser in another time zone', () => {
  test.use({ timezoneId: 'Australia/Sydney' });

  test("Last Rcvd counts from the player's clock, not the browser's", async ({ page, request }) => {
    test.fail(true, "ShowMultiSyncStats parses fppd's zone-less local time in the browser's zone (FUTURE.md)");
    const zone = String((await (await request.get('/api/settings/TimeZone')).json()).value || 'UTC');
    expect(zone, 'the player is not in the browser\'s zone').not.toBe('Australia/Sydney');
    // 90 s ago, written as fppd would: the player's wall clock.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(Date.now() - 90_000)).map((p) => [p.type, p.value]));
    const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    await lastRcvd(page, [stamp]);
    const cell = page.locator('#syncStatsTable tbody tr td:nth-child(2) span');
    await expect(cell).toHaveCount(1);
    await expect(cell).toHaveText(/^[12] min$/);
  });
});
