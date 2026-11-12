import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Scheduler's user holidays and its failed saves.  A schedule entry names
// a holiday by its config name, so renaming one in the holiday editor has to
// rename it in every entry that uses it, or those entries stop running on
// that day.  And a save the player rejects has to say so: a schedule the user
// believes is saved and is not is a show that does not start.
// The schedule and the holidays file are the receiving end, put back after.

const PL = 'fpp-tests-holiday-pl';
const HOLIDAYS = [
  { name: 'fpp-tests Switch On', shortName: 'FppTestsOn', month: 11, day: 20 },
  { name: 'fpp-tests Switch Off', shortName: 'FppTestsOff', month: 1, day: 6 },
  { name: 'fpp-tests Spare', shortName: 'FppTestsSpare', month: 6, day: 1 },
];

const entry = (extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist: PL, startTime: '19:00:00', endTime: '20:00:00',
  startDate: 'FppTestsOn', endDate: 'FppTestsOff', repeat: 0, stopType: 0, ...extra,
});
const year = new Date().getFullYear();
const DATED = entry({ startDate: `${year}-03-01`, endDate: `${year}-03-31`, startTime: '08:00:00', endTime: '09:00:00' });

let schedule: unknown;
let holidays: string | null;

const holidayFile = async (request: APIRequestContext) => (await request.get('/api/configfile/user-holidays.json')).json();
const savedSchedule = async (request: APIRequestContext) => (await request.get('/api/schedule')).json();
const dates = async (request: APIRequestContext) => (await savedSchedule(request)).map((e: any) => [e.startDate, e.endDate]);

test.beforeEach(async ({ request }) => {
  schedule = await savedSchedule(request);
  const h = await request.get('/api/configfile/user-holidays.json');
  holidays = h.ok() ? await h.text() : null;
  expect((await request.post(`/api/playlist/${PL}`, {
    data: { name: PL, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  })).ok()).toBe(true);
  expect((await request.post('/api/configfile/user-holidays.json', { data: HOLIDAYS })).ok()).toBe(true);
  expect((await request.post('/api/schedule', { data: [entry(), DATED] })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: schedule });
  if (holidays === null) await request.delete('/api/configfile/user-holidays.json');
  else await request.post('/api/configfile/user-holidays.json', { data: Buffer.from(holidays), headers: { 'Content-Type': 'application/json' } });
  await request.post('/api/schedule/reload');
  await request.delete(`/api/playlist/${PL}`);
});

async function openScheduler(page: Page) {
  await page.goto('/scheduler.php');
  const rows = page.locator('#tblScheduleBody > tr');
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  return rows;
}

async function openHolidays(page: Page) {
  const modal = page.locator('#holidayEditorModal');
  const shown = modal.evaluate((el) => new Promise<void>((r) => el.addEventListener('shown.bs.modal', () => r(), { once: true })));
  await page.evaluate(() => (window as any).OpenHolidayEditor());
  await shown;
  await expect(modal.locator('#tblUserHolidaysBody tr')).toHaveCount(HOLIDAYS.length);
  return modal;
}
const holidayRow = (page: Page, shortName: string) =>
  page.locator('#tblUserHolidaysBody tr').filter({ has: page.locator(`input.holShortName[value="${shortName}"]`) });
const saveHolidays = (page: Page) => page.locator('#holidayEditorModal').getByRole('button', { name: 'Save', exact: true }).click();
const notice = (page: Page, text: string) => page.locator('.jGrowl-notification', { hasText: text });
// A saved holiday list reloads the page (to redraw the entries' holiday
// lists), which takes its notices with it: the file is what shows the save.
const shortNames = async (request: APIRequestContext) => (await holidayFile(request)).map((h: any) => h.shortName);

test("renaming a holiday's config name renames it in the schedule entries that use it", async ({ page, request }) => {
  await openScheduler(page);
  const modal = await openHolidays(page);
  await holidayRow(page, 'FppTestsOn').locator('.holShortName').fill('FppTestsLightsOn');
  await saveHolidays(page);

  await expect.poll(() => shortNames(request), { timeout: 15_000 }).toEqual(['FppTestsLightsOn', 'FppTestsOff', 'FppTestsSpare']);
  // The entry follows the holiday; its other date, and the dated entry, are as they were.
  await expect.poll(() => dates(request), { timeout: 15_000 }).toEqual([['FppTestsLightsOn', 'FppTestsOff'], [DATED.startDate, DATED.endDate]]);
  await expect(modal).toBeHidden();
  // ...and the page shows the entry on the renamed holiday, not on an unknown date.
  const start = page.locator('#tblScheduleBody > tr').first().locator('select.holidays').first();
  await expect(start).toHaveValue('FppTestsLightsOn');
  await expect(start.locator('option:checked')).toHaveText('fpp-tests Switch On');
});

// The holidays are saved first and the schedule rewritten after, so a failed
// rewrite leaves entries naming a holiday that no longer exists.
async function renameWithScheduleRefused(page: Page) {
  await openScheduler(page);
  await openHolidays(page);
  await page.route((u) => u.pathname === '/api/schedule', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.fallback());
  const reloaded = page.waitForEvent('load');
  await holidayRow(page, 'FppTestsOff').locator('.holShortName').fill('FppTestsLightsOff');
  await saveHolidays(page);
  await reloaded;
}

test('a holiday renamed when the schedule cannot be rewritten is still saved, and the entries keep the old name', async ({ page, request }) => {
  await renameWithScheduleRefused(page);
  expect(await shortNames(request)).toContain('FppTestsLightsOff');
  expect((await dates(request))[0]).toEqual(['FppTestsOn', 'FppTestsOff']);
});

test('...and the warning that the entries were not updated can be read', async ({ page }) => {
  await renameWithScheduleRefused(page);
  test.fail(true, 'the page reloads straight after raising the warning, which takes it away (FUTURE.md)');
  await expect(notice(page, 'Could not update schedule entries')).toBeVisible({ timeout: 3000 });
});

test('a holiday save the player does not take is reported, and the editor stays open with what was typed', async ({ page, request }) => {
  await openScheduler(page);
  const modal = await openHolidays(page);
  await page.route((u) => u.pathname.endsWith('/api/configfile/user-holidays.json'), (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.fallback());
  await holidayRow(page, 'FppTestsSpare').locator('.holName').fill('fpp-tests Renamed');
  await saveHolidays(page);

  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Error saving user holidays');
  await expect(page.locator('#holidayEditorModal .holName').nth(2)).toHaveValue('fpp-tests Renamed');
  await expect(modal.locator('#tblUserHolidaysBody tr')).toHaveCount(3);
  expect(await holidayFile(request)).toEqual(HOLIDAYS);
  expect(await notice(page, 'User holidays saved').count()).toBe(0);
});

test('a holiday deleted in the editor is gone from the file once saved, and not before', async ({ page, request }) => {
  await openScheduler(page);
  const modal = await openHolidays(page);
  await holidayRow(page, 'FppTestsSpare').locator('button.btn-danger').click();
  await expect(modal.locator('#tblUserHolidaysBody tr')).toHaveCount(2);
  expect(await holidayFile(request)).toEqual(HOLIDAYS);

  await saveHolidays(page);
  await expect.poll(() => holidayFile(request), { timeout: 15_000 }).toEqual(HOLIDAYS.slice(0, 2));
  await expect(modal).toBeHidden();
  // No config name changed, so the schedule is as it was.
  expect(await dates(request)).toEqual([['FppTestsOn', 'FppTestsOff'], [DATED.startDate, DATED.endDate]]);
  // The holiday is no longer offered for an entry's dates.
  await expect(page.locator('#tblScheduleBody > tr').first().locator('select.holidays').first().locator('option[value="FppTestsSpare"]')).toHaveCount(0);
});

test('a schedule save the player does not take is reported, and nothing is reloaded', async ({ page, request }) => {
  const rows = await openScheduler(page);
  let reloads = 0;
  await page.route((u) => u.pathname === '/api/schedule/reload', (route) => {
    reloads++;
    return route.fallback();
  });
  await page.route((u) => u.pathname === '/api/schedule', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'no' }) : route.fallback());
  await rows.first().locator('.schEnable').uncheck();
  await page.locator('input[value="Save"]:visible').first().click();

  const dialog = page.locator('#dialogOKPopup');
  await expect(dialog).toContainText('Error saving schedule');
  await expect(dialog.locator('.modal-title')).toHaveText('Error saving');
  expect(await notice(page, 'Schedule saved').count()).toBe(0);
  expect(reloads, 'fppd was not asked to reload a schedule that was not saved').toBe(0);
  expect((await savedSchedule(request))[0].enabled).toBe(1);
  // What was changed is still on the page to save again.
  await expect(rows.first().locator('.schEnable')).not.toBeChecked();
});

test('an entry on a holiday can be moved to a date, and back to a holiday, and saves as shown', async ({ page, request }) => {
  const rows = await openScheduler(page);
  const cell = rows.first().locator('select.holidays').first().locator('xpath=..');
  const holiday = cell.locator('select.holidays');
  const date = cell.locator('input.date');
  await expect(holiday).toBeVisible();
  await expect(holiday).toHaveValue('FppTestsOn');
  await expect(date).toBeHidden();

  // Specify Date swaps the list for a date field holding today.
  await holiday.selectOption('SpecifyDate');
  await expect(holiday).toBeHidden();
  await expect(date).toBeVisible();
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await expect(date).toHaveValue(today);
  await expect(cell.locator('.dateOffset')).toBeHidden();

  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.locator('input[value="Save"]:visible').first().click();
  expect((await posted).ok()).toBe(true);
  expect((await dates(request))[0]).toEqual([today, 'FppTestsOff']);

  // The end date, still a holiday, offers a day offset; choosing another holiday keeps it one.
  const end = rows.first().locator('select.holidays').nth(1);
  await end.selectOption('FppTestsSpare');
  await expect(end).toBeVisible();
  const again = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.locator('input[value="Save"]:visible').first().click();
  expect((await again).ok()).toBe(true);
  expect((await dates(request))[0]).toEqual([today, 'FppTestsSpare']);
});
