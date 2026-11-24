import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// A Scheduler row whose playlist or sequence is no longer on the player
// (deleted, renamed, or a schedule copied from another player).
//
// The row's dropdown had no option for the saved name, so nothing was
// selected.  For a sequence, AddScheduleEntry then called .replace() on the
// null value and threw.  That stopped the load part way: later rows never
// appeared, and no row's Start or End Time got its time picker, the dropdown of
// times and Dawn/SunRise/SunSet/Dusk, because SetScheduleInputNames() runs once
// every row is in.  Save then wrote what the page showed: null for the name,
// and "" for the times of the row that threw.  A schedule left that way threw
// again on every load.  The saved name is now kept as a "Name (missing)" choice
// with a ⚠.  Everything is seeded and put back through the API, so this runs
// against any player.  Fix: 8b55f41c7.

const GOOD = 'fpp-tests-missing-ok';
const GONE_PLAYLIST = 'fpp-tests-missing-playlist';
const GONE_SEQUENCE = 'fpp-tests-missing-sequence.fseq';

let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  const r = await request.post(`/api/playlist/${GOOD}`, {
    data: { name: GOOD, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
  // The control: these really are absent.
  expect((await request.get(`/api/playlist/${GONE_PLAYLIST}`)).ok()).toBe(false);
  expect(await (await request.get('/api/sequence')).json()).not.toContain(GONE_SEQUENCE.replace(/\.fseq$/, ''));
});

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/schedule', { data: before })).ok()).toBe(true);
  await request.post('/api/schedule/reload');
  await request.delete(`/api/playlist/${GOOD}`);
});

const year = new Date().getFullYear();
const entry = (extra: object) => ({
  enabled: 0, day: 7, sequence: 0, playlist: GOOD, startTime: '19:00:00', endTime: '20:00:00',
  startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

async function openScheduler(page: Page, request: APIRequestContext, schedule: object[]) {
  expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  const rows = page.locator('#tblScheduleBody > tr');
  await expect(rows).toHaveCount(schedule.length, { timeout: 15_000 });
  return rows;
}

// Every Start and End Time is a time picker, and one opens on a click.
async function expectTimePickers(page: Page, rows: ReturnType<Page['locator']>) {
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await expect(rows.nth(i).locator('.schStartTime')).toHaveClass(/ui-timepicker-input/);
    await expect(rows.nth(i).locator('.schEndTime')).toHaveClass(/ui-timepicker-input/);
  }
  await rows.last().locator('.schStartTime').click();
  const list = page.locator('.ui-timepicker-wrapper:visible');
  await expect(list).toHaveCount(1);
  await expect(list).toContainText('SunSet');
}

test('a row whose sequence or playlist is gone loads, keeps its name, and every row keeps its time pickers', async ({ page, request }) => {
  const rows = await openScheduler(page, request, [
    entry({}),
    entry({ sequence: 1, playlist: GONE_SEQUENCE }),
    entry({ playlist: GONE_PLAYLIST }),
    entry({ startTime: '08:00:00' }),
  ]);
  await expectTimePickers(page, rows);

  const seq = rows.nth(1).locator('.schSequence');
  await expect(seq).toHaveValue(GONE_SEQUENCE);
  await expect(seq.locator('option:checked')).toHaveText('fpp-tests-missing-sequence (missing)');
  await expect(seq).toHaveClass(/inputWarning/);
  await expect(rows.nth(1).locator('.schPlaylistWarning')).toHaveAttribute('aria-label', /sequence is not on this player/);

  const pl = rows.nth(2).locator('.schPlaylist');
  await expect(pl).toHaveValue(GONE_PLAYLIST);
  await expect(pl.locator('option:checked')).toHaveText(`${GONE_PLAYLIST} (missing)`);
  await expect(rows.nth(2).locator('.schPlaylistWarning')).toHaveAttribute('aria-label', /playlist is not on this player/);

  // The control: a playlist that is there is neither marked nor warned about.
  await expect(rows.nth(0).locator('.schPlaylist option:checked')).toHaveText(GOOD);
  await expect(rows.nth(0).locator('.schPlaylistWarning')).toHaveCount(0);
  await expect(rows.nth(3).locator('.schStartTime')).toHaveValue(/^0?8:00/);

  // Picking a playlist that is there takes the ⚠ away.
  await pl.selectOption(GOOD);
  await expect(rows.nth(2).locator('.schPlaylistWarning')).toHaveCount(0);
});

test('a sequence row that an earlier Save left with no name and no times still loads', async ({ page, request }) => {
  // What Save wrote for a row that threw on load.
  const rows = await openScheduler(page, request, [
    entry({}),
    entry({ sequence: 1, playlist: null, startTime: '', endTime: '' }),
    entry({ startTime: '08:00:00' }),
  ]);
  await expectTimePickers(page, rows);
  await expect(rows.nth(1).locator('.schSequence')).toHaveClass(/inputWarning/);
});

async function saveAndRead(page: Page, request: APIRequestContext) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.locator('input[value="Save"]:visible').first().click();
  expect((await posted).ok()).toBe(true);
  const saved = await (await request.get('/api/schedule')).json();
  return saved.map((e: any) => [e.sequence, e.playlist, e.startTime, e.endTime]);
}

// A missing playlist never threw; Save just wrote null over its name.
test('Save keeps the name of a playlist that is gone', async ({ page, request }) => {
  await openScheduler(page, request, [entry({}), entry({ playlist: GONE_PLAYLIST })]);
  expect(await saveAndRead(page, request)).toEqual([
    [0, GOOD, '19:00:00', '20:00:00'],
    [0, GONE_PLAYLIST, '19:00:00', '20:00:00'],
  ]);
});

test('Save keeps the name of a sequence that is gone', async ({ page, request }) => {
  await openScheduler(page, request, [entry({}), entry({ sequence: 1, playlist: GONE_SEQUENCE })]);
  expect(await saveAndRead(page, request)).toEqual([
    [0, GOOD, '19:00:00', '20:00:00'],
    [1, GONE_SEQUENCE, '19:00:00', '20:00:00'],
  ]);
});
