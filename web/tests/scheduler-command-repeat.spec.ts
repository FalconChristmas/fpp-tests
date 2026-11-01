import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// A Command entry on the Scheduler page (scheduler.php) can repeat like a
// playlist's, every 5 to 60 minutes, but not "Immediate" (there is nothing for
// a command to repeat once it ends).  Each test puts the schedule back as it
// found it.

let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
});

test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
});

const year = new Date().getFullYear();

function command(extra: object = {}) {
  return {
    enabled: 1, day: 7, type: 'command', playlist: '', command: 'Stop Now', args: [], startTime: '19:00:00',
    endTime: '19:00:00', startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
  };
}

async function storeSchedule(request: APIRequestContext, schedule: object[]) {
  expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
}

const rows = (page: Page) => page.locator('#tblScheduleBody > tr');

async function openScheduler(page: Page) {
  await page.goto('/scheduler.php');
  await expect(page.locator('.fppTableRowTemplate .schType')).toHaveCount(1);
}

async function save(page: Page, request: APIRequestContext) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await page.evaluate(() => (window as any).SaveSchedule());
  expect((await posted).ok()).toBe(true);
  return (await request.get('/api/schedule')).json();
}

// The Repeat choices a row offers, as the user sees them (a hidden <option>
// is not offered).
const offeredRepeats = (page: Page, row: ReturnType<typeof rows>) =>
  row.locator('.schRepeat option').evaluateAll((os) =>
    os.filter((o) => getComputedStyle(o).display !== 'none').map((o) => (o as HTMLOptionElement).value));

test('a Command is offered every repeat interval but Immediate, a Playlist all of them', async ({ page, request }) => {
  // Feature: 325da717d.  FPP Commands can be scheduled to repeat; the
  // "Immediate" interval is disabled for them.
  await storeSchedule(request, [command(), { ...command(), type: 'playlist', command: '', playlist: 'fpp-tests-none' }]);
  await openScheduler(page);
  await expect(rows(page)).toHaveCount(2);
  const interval = ['0', '500', '1000', '1500', '2000', '3000', '6000'];
  expect(await offeredRepeats(page, rows(page).nth(0)), 'a Command row').toEqual(interval);
  expect(await offeredRepeats(page, rows(page).nth(1)), 'a Playlist row').toEqual(['0', '1', ...interval.slice(1)]);
  // Changing a row's type changes the choices with it.
  await rows(page).nth(1).locator('.schType').selectOption('command');
  expect(await offeredRepeats(page, rows(page).nth(1))).toEqual(interval);
  await rows(page).nth(1).locator('.schType').selectOption('playlist');
  expect(await offeredRepeats(page, rows(page).nth(1))).toEqual(['0', '1', ...interval.slice(1)]);
});

test('a Command stored as repeating Immediately is shown, and saved, as not repeating', async ({ page, request }) => {
  // Feature: 325da717d.  Entries made before the interval was disabled for
  // commands carry repeat 1.
  await storeSchedule(request, [command({ repeat: 1, endTime: '23:59:59' })]);
  await openScheduler(page);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).nth(0).locator('.schRepeat')).toHaveValue('0');
  const [saved] = await save(page, request);
  expect(saved).toMatchObject({ command: 'Stop Now', repeat: 0 });
  // The receiving end: fppd takes the saved schedule.
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
  expect((await request.get('/api/fppd/schedule')).ok()).toBe(true);
});

test('a Command that repeats every 15 minutes keeps its repeat and its end time through Save', async ({ page, request }) => {
  // Feature: 325da717d.
  await storeSchedule(request, [command({ repeat: 1500, endTime: '21:00:00' })]);
  await openScheduler(page);
  await expect(rows(page).nth(0).locator('.schRepeat')).toHaveValue('1500');
  await expect(rows(page).nth(0).locator('.schEndTime')).toBeVisible();
  const [saved] = await save(page, request);
  expect(saved).toMatchObject({ command: 'Stop Now', repeat: 1500 });
  expect(saved.startTime).toMatch(/^19:00/);
  expect(saved.endTime).toMatch(/^21:00/);
});
