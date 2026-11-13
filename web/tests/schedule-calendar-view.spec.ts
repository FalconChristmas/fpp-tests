import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Scheduler's "Preview > Calendar View" (scheduleCalendar.php, FullCalendar
// in fpp.js): what it shows for a real schedule, which fppd expands over the
// span on screen (api/fppd/schedule/range).  The List view is read here: one
// row per occurrence, with the entry's title.  Entries run at midday, so the
// browser's and the player's time zones can differ by up to 10 hours and each
// still lands on the same day: a week shows exactly seven of a daily entry.
// (A list shows an entry that crosses midnight on both days.)
// (schedule-calendar-event-text.spec.ts: the event text colour.)

const A = 'fpp-tests-cal-a';
const B = 'fpp-tests-cal-b';
let before: unknown;

const year = new Date().getFullYear();
const entry = (playlist: string, extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist, command: '', args: [],
  startTime: '12:00:00', endTime: '13:00:00',
  startDate: `${year - 1}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

// fppd leaves out an entry whose playlist isn't there, so both are made.
test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  for (const name of [A, B]) {
    const r = await request.post(`/api/playlist/${name}`, {
      data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(r.ok()).toBe(true);
  }
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  for (const name of [A, B]) await request.delete(`/api/playlist/${name}`);
});

// fppd reloads lazily, on its scheduler's next pass: wait until it serves the
// schedule just saved, so the calendar is not read against the old one.
async function useSchedule(request: APIRequestContext, entries: object[]) {
  const r = await request.post('/api/schedule', { data: entries });
  expect(r.ok(), await r.text()).toBe(true);
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
  const want = entries.map((e: any) => e.playlist || e.command);
  await expect.poll(async () =>
    ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
      .map((e: any) => e.playlist || e.command), { message: 'the control: fppd runs the schedule', timeout: 10_000 })
    .toEqual(want);
}

async function openCalendar(page: Page) {
  await page.goto('/scheduler.php');
  await page.locator('#schedulerPreviewActions').click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Calendar View' }).click();
  const calendar = page.locator('#scheduleCalendarModal');
  await expect(calendar.locator('.fc-daygrid-body, .fc-dayGridMonth-view').first()).toBeVisible({ timeout: 15_000 });
  await calendar.locator('.fc-listWeek-button').click();
  await expect(calendar.locator('.fc-list')).toBeVisible();
  return calendar;
}

const rows = (calendar: ReturnType<Page['locator']>, title: string) =>
  calendar.locator('.fc-list-event').filter({ has: calendar.page().locator('.fc-list-event-title', { hasText: new RegExp(`^${title}$`) }) });

test('a week of the schedule shows each entry on each day it runs, playlists and commands', async ({ page, request }) => {
  await useSchedule(request, [
    entry(A),
    entry('', { type: 'command', command: 'All Lights Off', startTime: '12:30:00', endTime: '12:30:00' }),
    // Weekends only (day 9): two days of any week.  Later in the day, so A,
    // above it, is not running when it starts.
    entry(B, { day: 9, startTime: '15:00:00', endTime: '16:00:00' }),
  ]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, A)).toHaveCount(7);
  await expect(rows(calendar, 'All Lights Off')).toHaveCount(7);
  await expect(rows(calendar, 'All Lights Off').first()).toHaveClass(/sch-cal-event-command/);
  await expect(rows(calendar, B)).toHaveCount(2);
});

test('a playlist a higher one already covers is hidden as overridden, and shown with the switch off', async ({ page, request }) => {
  // B starts while A (above it, so higher priority) is still running: the
  // scheduler skips B.
  await useSchedule(request, [entry(A, { endTime: '14:00:00' }), entry(B, { startTime: '13:00:00', endTime: '13:30:00' })]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, A)).toHaveCount(7);
  await expect(rows(calendar, B)).toHaveCount(0);
  await calendar.locator('#schCalHideOverridden').uncheck();
  await expect(rows(calendar, B)).toHaveCount(7);
  await expect(rows(calendar, B).first()).toHaveClass(/sch-cal-event-overridden/);
  await expect(rows(calendar, A).first()).not.toHaveClass(/sch-cal-event-overridden/);
});

test('a disabled entry is left out, and shown as disabled with the switch on', async ({ page, request }) => {
  await useSchedule(request, [entry(A), entry(B, { enabled: 0, startTime: '15:00:00', endTime: '16:00:00' })]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, A)).toHaveCount(7);
  await expect(rows(calendar, B)).toHaveCount(0);
  await calendar.locator('#schCalShowDisabled').check();
  await expect(rows(calendar, B)).toHaveCount(7);
  await expect(rows(calendar, B).first()).toHaveClass(/sch-cal-event-disabled/);
});

test('the calendar opened again shows the schedule as it is now', async ({ page, request }) => {
  // Closing the dialog throws the calendar away, so a reopen asks fppd again.
  await useSchedule(request, [entry(A)]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, A)).toHaveCount(7);
  await calendar.locator('.btn-close, [data-bs-dismiss="modal"]').first().click();
  await expect(calendar).toBeHidden();

  await useSchedule(request, [entry(B)]);
  await page.locator('#schedulerPreviewActions').click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Calendar View' }).click();
  await expect(calendar.locator('.fc-dayGridMonth-view')).toBeVisible({ timeout: 15_000 });
  await calendar.locator('.fc-listWeek-button').click();
  await expect(rows(calendar, B)).toHaveCount(7);
  await expect(rows(calendar, A)).toHaveCount(0);
});

test('showing disabled entries does not hide a playlist that will play', async ({ page, request }) => {
  // Regression: 9ea849418.  Scheduler::GetScheduleRange() collected the playlist windows
  // that can override before checking the entry was enabled, so with disabled
  // entries shown a disabled playlist above B marked B overridden, and "Hide
  // overridden" (on by default) took B, which will run, off the calendar.
  // The scheduler never runs a disabled entry, so it overrides nothing.
  await useSchedule(request, [entry(A, { enabled: 0, endTime: '14:00:00' }), entry(B, { startTime: '13:00:00', endTime: '13:30:00' })]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, B), 'the control: B shows while disabled entries are left out').toHaveCount(7);
  await calendar.locator('#schCalShowDisabled').check();
  await expect(rows(calendar, A)).toHaveCount(7);
  await expect(rows(calendar, B)).toHaveCount(7, { timeout: 3000 });
  await expect(rows(calendar, B).first()).not.toHaveClass(/sch-cal-event-overridden/);
});

test('a command late in the evening is listed once a day', async ({ page, request }) => {
  // A command has no length (its end is its start), and FullCalendar draws a
  // timed event without one an hour long (defaultTimedEventDuration): a
  // command at 23:30 runs on to 00:30 on screen, so the list shows it again
  // at 12:00 AM the next day.  The first test above is the control, at 12:30.
  await useSchedule(request, [entry('', { type: 'command', command: 'All Lights Off', startTime: '23:30:00', endTime: '23:30:00' })]);
  const calendar = await openCalendar(page);
  await expect(rows(calendar, 'All Lights Off').first()).toBeVisible();
  await expect(rows(calendar, 'All Lights Off')).toHaveCount(7);
});
