import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The Scheduler page's time fields in 12-hour time.  fppd takes an end time
// of 24:00:00 as the midnight that ends the day; the page shows it as
// "12:00 Mid", apart from the "12:00 AM" that starts it.  The fields use
// jquery.timepicker, which FPP patches for that second midnight.
// Also 1371d56ff: the page's own conversions show 24:00:00 as "Mid" and save
// "Mid" as 24:00:00 (not 00:00:00).

const PLAYLIST = 'fpp-tests-sched-midnight';
const year = new Date().getFullYear();

let before: unknown;
let timeFormat: unknown;
const setting = async (request: APIRequestContext, key: string) => (await (await request.get(`/api/settings/${key}`)).json())?.value;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  timeFormat = await setting(request, 'TimeFormat');
  await request.put('/api/settings/TimeFormat', { data: '%I:%M %p' });
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
});

test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  await request.put('/api/settings/TimeFormat', { data: String(timeFormat ?? '%I:%M %p') });
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

test('an entry ending at the second midnight keeps it through the time picker and Save', async ({ page, request }) => {
  // Regression: ecf118de8.  The time picker knew only one midnight: its
  // list ended on a second "12:00 AM", and when it re-read the field it
  // took "12:00 Mid" as 12:00 AM, so a show set to run until midnight was
  // saved ending at 00:00:00, the start of the day.
  expect((await request.post('/api/schedule', { data: [{
    enabled: 1, day: 7, type: 'playlist', playlist: PLAYLIST, startTime: '18:00:00', endTime: '24:00:00',
    startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0,
  }] })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  const end = page.locator('#tblScheduleBody > tr').first().locator('.schEndTime');
  await expect(end).toHaveValue('12:00 Mid', { timeout: 15_000 });

  // The picker's list offers it last, by that name, apart from the first
  // midnight (which follows Dawn, SunRise, SunSet and Dusk).
  await end.click();
  const options = page.locator('.ui-timepicker-wrapper:visible .ui-timepicker-list li');
  await expect(options.last()).toHaveText('12:00 Mid');
  await expect(options.filter({ hasText: /^12:00 AM$/ })).toHaveCount(1);
  // Leaving the field has the picker re-read and rewrite it.
  await end.press('Tab');
  await expect(end).toHaveValue('12:00 Mid');

  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.evaluate(() => (window as any).SaveSchedule());
  expect((await posted).ok()).toBe(true);
  const saved = (await (await request.get('/api/schedule')).json())[0];
  expect(saved).toMatchObject({ startTime: '18:00:00', endTime: '24:00:00' });
});
