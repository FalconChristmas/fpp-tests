import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The status page's "Packets and Bytes Received" tables
// (GetUniverseBytesReceived in fpp.js), drawn from /api/channel/input/stats.
// The stats are given here (api-channel-input-stats.spec.ts has the real
// ones): how many universes, and what was counted for each.

type Universe = { id: number; startChannel: number; packetsReceived: number; bytesReceived: number; errors: number; suppressedPackets?: number };
const universes = (n: number): Universe[] =>
  Array.from({ length: n }, (_, i) => ({ id: 100 + i, startChannel: 1 + i * 512, packetsReceived: 10 + i, bytesReceived: 5120 + i, errors: i % 2 }));

async function draw(page: Page, answer: { status?: number; json?: unknown }) {
  await page.unroute('**/api/channel/input/stats');
  await page.route('**/api/channel/input/stats', (route) =>
    route.fulfill({ status: answer.status ?? 200, contentType: 'application/json', body: JSON.stringify(answer.json ?? {}) }));
  const got = page.waitForResponse((r) => r.url().includes('/api/channel/input/stats'));
  await page.evaluate(() => {
    (window as any).$('#bridgeModeInfo').show();
    (window as any).GetUniverseBytesReceived();
  });
  await got;
}

// The rows of each of the three columns of tables, header first.
const tables = (page: Page) => page.evaluate(() => ['#bridgeStatistics1', '#bridgeStatistics2', '#bridgeStatistics3'].map((box) =>
  [...document.querySelectorAll(`${box} tr`)].map((tr) => [...tr.children].map((c) => c.textContent).join(' | '))));

test.beforeEach(async ({ page }) => {
  await page.goto('/index.php');
  await expect(page.locator('#bridgeStatistics1')).toBeAttached({ timeout: 15_000 });
});

test('each input universe gets a row of what it has received', async ({ page }) => {
  await draw(page, { json: { status: 'OK', universes: universes(3) } });
  await expect.poll(() => tables(page)).toEqual([[
    'Universe | Start Address | Packets | Bytes | Errors',
    '100 | 1 | 10 | 5120 | 0',
    '101 | 513 | 11 | 5121 | 1',
    '102 | 1025 | 12 | 5122 | 0',
  ], [], []]);

  // No input universes: no table at all.
  await draw(page, { json: { status: 'OK', universes: [] } });
  await expect.poll(() => tables(page)).toEqual([[], [], []]);
  await expect(page.locator('#bridgeStatistics1 table')).toHaveCount(0);
});

test('the Suppressed column appears once a universe has had packets suppressed', async ({ page }) => {
  const list = universes(3);
  list[0].suppressedPackets = 0;
  list[1].suppressedPackets = 7;
  await draw(page, { json: { status: 'OK', universes: list } });
  // The third universe's input has no count (an fppd without the priority feature for it).
  await expect.poll(() => tables(page)).toEqual([[
    'Universe | Start Address | Packets | Bytes | Errors | Suppressed',
    '100 | 1 | 10 | 5120 | 0 | 0',
    '101 | 513 | 11 | 5121 | 1 | 7',
    '102 | 1025 | 12 | 5122 | 0 | -',
  ], [], []]);
});

const lengths = async (page: Page) => (await tables(page)).map((t) => Math.max(0, t.length - 1));

test('past 32 universes the rows run on into a second and a third table', async ({ page }) => {
  await draw(page, { json: { status: 'OK', universes: universes(32) } });
  await expect.poll(() => lengths(page)).toEqual([32, 0, 0]);
  await draw(page, { json: { status: 'OK', universes: universes(40) } });
  await expect.poll(() => lengths(page)).toEqual([32, 8, 0]);
  await draw(page, { json: { status: 'OK', universes: universes(96) } });
  await expect.poll(() => lengths(page)).toEqual([32, 32, 32]);
  // More than fill three tables of 32: three even ones.
  await draw(page, { json: { status: 'OK', universes: universes(99) } });
  await expect.poll(() => lengths(page)).toEqual([33, 33, 33]);
  // Every table has its header, and the rows carry on in order.
  const t = await tables(page);
  expect(t.map((x) => x[0])).toEqual(Array(3).fill('Universe | Start Address | Packets | Bytes | Errors'));
  expect([t[0][33], t[1][1], t[1][33], t[2][1]].map((r) => r.split(' | ')[0])).toEqual(['132', '133', '165', '166']);
  // Fewer again: the tables no longer needed are emptied.
  await draw(page, { json: { status: 'OK', universes: universes(2) } });
  await expect.poll(() => lengths(page)).toEqual([2, 0, 0]);
});

test('100 universes are spread over the three tables too', async ({ page }) => {
  // FUTURE.md: the table length is universes / 3, not rounded, and the row
  // number is compared to it with ==, so a count over 96 that is not a
  // multiple of three never starts a second table: one table of 100 rows.
  test.fail();
  await draw(page, { json: { status: 'OK', universes: universes(100) } });
  await expect.poll(() => lengths(page), { timeout: 3000 }).toEqual([34, 34, 32]);
});

test('a refusal from fppd, and no answer, are said in place of the tables', async ({ page }) => {
  await draw(page, { json: { status: 'OK', universes: universes(40) } });
  await expect.poll(() => lengths(page)).toEqual([32, 8, 0]);
  await draw(page, { json: { status: 'ERROR: no inputs' } });
  await expect(page.locator('#bridgeStatistics1')).toHaveText('Bridge Data not avaiable -- ERROR: no inputs');
  await expect(page.locator('#bridgeStatistics2')).toBeEmpty();

  await draw(page, { json: { status: 'OK', universes: universes(40) } });
  await draw(page, { status: 500 });
  await expect(page.locator('#bridgeStatistics1')).toHaveText('Failed to refresh Bridge Stats - Unknown Error');
  await expect(page.locator('#bridgeStatistics2')).toBeEmpty();
});
