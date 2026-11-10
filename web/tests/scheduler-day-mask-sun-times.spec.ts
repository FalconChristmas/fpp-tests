import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// Two things a schedule entry can say that the Scheduler page has to carry
// through to fppd: a Day Mask (any set of weekdays, saved as 0x10000 with a
// bit per day, INX_DAY_MASK_* in ScheduleEntry.h) and a start or end at the
// sun (SunRise, SunSet, Dawn, Dusk, with an offset in minutes; FPP once saved
// SunRise and SunSet as 25:00:00 and 26:00:00).  Each is drawn from a saved
// schedule and saved back as it was, and a mask ticked on the page is the
// set of days fppd plans the show on.

const PLAYLIST = 'fpp-tests-sched-mask';
const MASK = 0x10000;
const DAY = { Sunday: 0x4000, Monday: 0x2000, Tuesday: 0x1000, Wednesday: 0x0800, Thursday: 0x0400, Friday: 0x0200, Saturday: 0x0100 };

const entry = (extra: object) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, sequence: 0, startTime: '19:00:00', startTimeOffset: 0,
  endTime: '22:00:00', endTimeOffset: 0, repeat: 0, startDate: '2026-01-01', startDateOffset: 0,
  endDate: '2027-12-31', endDateOffset: 0, stopType: 0, ...extra,
});

let before: unknown;
let timeFormat: unknown;
test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  timeFormat = (await (await request.get('/api/settings/TimeFormat')).json())?.value;
  await request.put('/api/settings/TimeFormat', { data: '%H:%M' });
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [{ type: 'pause', enabled: 1, playOnce: 0, duration: 1 }], leadOut: [] },
  });
  expect(pl.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  await request.put('/api/settings/TimeFormat', { data: String(timeFormat ?? '%I:%M %p') });
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

const rows = (page: Page) => page.locator('#tblScheduleBody > tr');
async function open(page: Page, count: number) {
  await page.goto('/scheduler.php');
  await expect(rows(page)).toHaveCount(count, { timeout: 15_000 });
}
async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.evaluate(() => (window as any).SaveSchedule());
  expect((await posted).ok()).toBe(true);
}
const saved = async (request: APIRequestContext) => (await (await request.get('/api/schedule')).json()) as any[];
const ticked = (row: ReturnType<Page['locator']>) => Promise.all(Object.keys(DAY).map(async (d) =>
  (await row.locator(`.mask${d}`).isChecked()) ? d : '')).then((x) => x.filter(Boolean));

test('a saved day mask is drawn as its days and saved back as it was', async ({ page, request }) => {
  const mwf = MASK | DAY.Monday | DAY.Wednesday | DAY.Friday;
  const weekend = MASK | DAY.Saturday | DAY.Sunday;
  const none = MASK;
  await request.post('/api/schedule', { data: [entry({ day: mwf }), entry({ day: weekend }), entry({ day: none }), entry({ day: 7 })] });
  await open(page, 4);
  await expect(rows(page).nth(0).locator('.schDay')).toHaveValue(String(MASK));
  expect(await ticked(rows(page).nth(0))).toEqual(['Monday', 'Wednesday', 'Friday']);
  expect(await ticked(rows(page).nth(1))).toEqual(['Sunday', 'Saturday']);
  await expect(rows(page).nth(2).locator('.schDay')).toHaveValue(String(MASK));
  expect(await ticked(rows(page).nth(2))).toEqual([]);
  // An ordinary day choice has no mask shown.
  await expect(rows(page).nth(3).locator('.schDay')).toHaveValue('7');
  await save(page);
  expect((await saved(request)).map((e) => e.day)).toEqual([mwf, weekend, none, 7]);
});

test('days ticked on the page are the days fppd plans the show on', async ({ page, request }) => {
  await request.post('/api/schedule', { data: [entry({ day: 7 })] });
  await open(page, 1);
  const row = rows(page).nth(0);
  await row.locator('.schDay').selectOption(String(MASK));
  for (const d of ['Tuesday', 'Thursday', 'Saturday']) await row.locator(`.mask${d}`).check();
  await save(page);
  expect((await saved(request))[0].day).toBe(MASK | DAY.Tuesday | DAY.Thursday | DAY.Saturday);

  await request.post('/api/schedule/reload');
  await expect.poll(async () => (await (await request.get('/api/fppd/schedule')).json()).schedule.entries[0]?.dayStr,
    { timeout: 10_000 }).toBe('Mask: --T-T-S');
  const items: any[] = (await (await request.get('/api/fppd/schedule')).json()).schedule.items;
  expect(items.length).toBeGreaterThan(2);
  const weekday = (d: number) => new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100)).getUTCDay();
  for (const i of items) expect([2, 4, 6], `${i.startTimeStr}`).toContain(weekday(i.startDateInt));
});

test('starts and ends at the sun, with their offsets, are drawn and saved back, the old 25:00 and 26:00 as SunRise and SunSet', async ({ page, request }) => {
  await request.post('/api/schedule', { data: [
    entry({ startTime: 'SunSet', startTimeOffset: -30, endTime: 'SunRise', endTimeOffset: 45 }),
    entry({ startTime: 'Dusk', startTimeOffset: 10, endTime: 'Dawn', endTimeOffset: -5 }),
    entry({ startTime: '26:00:00', startTimeOffset: 15, endTime: '25:00:00', endTimeOffset: 0 }),
    entry({ startTime: 'SunSet', endTime: '23:30:00' }),
  ] });
  await open(page, 4);
  const shown = async (n: number) => [
    await rows(page).nth(n).locator('.schStartTime').inputValue(),
    await rows(page).nth(n).locator('.schStartTimeOffset').inputValue(),
    await rows(page).nth(n).locator('.schEndTime').inputValue(),
    await rows(page).nth(n).locator('.schEndTimeOffset').inputValue(),
  ];
  expect(await shown(0)).toEqual(['SunSet', '-30', 'SunRise', '45']);
  expect(await shown(1)).toEqual(['Dusk', '10', 'Dawn', '-5']);
  expect(await shown(2)).toEqual(['SunSet', '15', 'SunRise', '0']);
  expect((await shown(3)).slice(0, 3)).toEqual(['SunSet', '0', '23:30']);
  // A sun time shows its offset; a clock time does not.
  await expect(rows(page).nth(0).locator('.schStartTimeOffset')).toBeVisible();
  await expect(rows(page).nth(3).locator('.schEndTimeOffset')).toBeHidden();
  await save(page);
  const out = (await saved(request)).map((e) => [e.startTime, e.startTimeOffset, e.endTime, e.endTimeOffset]);
  expect(out).toEqual([
    ['SunSet', -30, 'SunRise', 45],
    ['Dusk', 10, 'Dawn', -5],
    ['SunSet', 15, 'SunRise', 0],
    ['SunSet', 0, '23:30:00', 0],
  ]);
});
