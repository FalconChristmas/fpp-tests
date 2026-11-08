import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Scheduler page's row buttons: Clone, Delete and Clear Selection, and
// dragging a row to change its priority (a row higher up wins when two
// overlap).  None of them saves anything; Save writes the table as it then is
// (api/schedule) and asks fppd to reload it (api/schedule/reload).
// (scheduler-page-entries.spec.ts: what a row shows and saves for an entry.)
//
// A row button that is off carries the disableButtons class; on page load it
// has only the class (SetButtonState() adds the disabled attribute once it runs).

const PL = ['fpp-tests-row-a', 'fpp-tests-row-b', 'fpp-tests-row-c'];
let before: unknown;

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  for (const name of PL) {
    const r = await request.post(`/api/playlist/${name}`, {
      data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(r.ok()).toBe(true);
  }
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  for (const name of PL) await request.delete(`/api/playlist/${name}`);
});

const year = new Date().getFullYear();
const entry = (playlist: string, extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist, startTime: '19:00:00', endTime: '20:00:00',
  startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

const saved = async (request: APIRequestContext) => (await request.get('/api/schedule')).json();
const names = async (request: APIRequestContext) => (await saved(request)).map((e: any) => e.playlist);

async function openPage(page: Page, request: APIRequestContext, schedule: object[]) {
  expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
  await page.goto('/scheduler.php');
  const rows = page.locator('#tblScheduleBody > tr');
  await expect(rows).toHaveCount(schedule.length, { timeout: 15_000 });
  return rows;
}

// A row is selected by a mousedown on it (the grip cell holds no input); with
// Ctrl held it is added to the selection.
const pick = (rows: ReturnType<Page['locator']>, i: number, add = false) =>
  rows.nth(i).locator('td').first().dispatchEvent('mousedown', { ctrlKey: add });
const button = (page: Page, value: string) => page.locator(`input[value="${value}"]:visible`).first();

async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
  await button(page, 'Save').click();
  expect((await posted).ok()).toBe(true);
}

test('Clone adds a copy of the selected row that Save stores the same as the original', async ({ page, request }) => {
  // An entry with most of its fields away from the defaults: weekdays, a
  // repeating playlist, a graceful stop, its own dates and times.
  const rich = entry(PL[1], { day: 8, startTime: '18:30:00', endTime: '23:15:00', repeat: 1, stopType: 1,
    startDate: `${year}-11-25`, endDate: `${year + 1}-01-06` });
  const rows = await openPage(page, request, [entry(PL[0]), rich]);
  await expect(button(page, 'Clone')).toHaveClass(/\bdisableButtons\b/);
  await pick(rows, 1);
  await expect(button(page, 'Clone')).not.toHaveClass(/\bdisableButtons\b/);
  await button(page, 'Clone').click();
  await expect(rows).toHaveCount(3);
  expect(await names(request), 'Clone saves nothing by itself').toEqual([PL[0], PL[1]]);

  await save(page);
  const after = await saved(request);
  expect(after.map((e: any) => e.playlist)).toEqual([PL[0], PL[1], PL[1]]);
  expect(after[2]).toEqual(after[1]);
  expect(after[1]).toMatchObject({ day: 8, startTime: '18:30:00', endTime: '23:15:00', repeat: 1, stopType: 1,
    startDate: `${year}-11-25`, endDate: `${year + 1}-01-06` });
});

test('Delete takes out only the selected rows, and nothing is gone until Save', async ({ page, request }) => {
  const rows = await openPage(page, request, PL.map((p) => entry(p)));
  await expect(button(page, 'Delete')).toHaveClass(/\bdisableButtons\b/);
  await pick(rows, 0);
  await pick(rows, 2, true);
  await button(page, 'Delete').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0).locator('.schPlaylist')).toHaveValue(PL[1]);
  await expect(button(page, 'Delete')).toHaveClass(/\bdisableButtons\b/);
  expect(await names(request), 'Delete saves nothing by itself').toEqual(PL);
  await save(page);
  expect(await names(request)).toEqual([PL[1]]);
});

test('Clear Selection leaves nothing for Delete or Clone to act on', async ({ page, request }) => {
  const rows = await openPage(page, request, [entry(PL[0]), entry(PL[1])]);
  await pick(rows, 0);
  await pick(rows, 1, true);
  await expect(page.locator('#tblScheduleBody > tr.selectedEntry')).toHaveCount(2);
  await button(page, 'Clear Selection').click();
  await expect(page.locator('#tblScheduleBody > tr.selectedEntry')).toHaveCount(0);
  await expect(button(page, 'Delete')).toHaveClass(/\bdisableButtons\b/);
  await expect(button(page, 'Clone')).toHaveClass(/\bdisableButtons\b/);
});

test('a row dragged above another is saved above it, so it takes priority', async ({ page, request }) => {
  const rows = await openPage(page, request, PL.map((p) => entry(p)));
  const from = await rows.nth(2).locator('.rowGrip').boundingBox();
  const to = await rows.nth(0).boundingBox();
  expect(from && to).toBeTruthy();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // jQuery UI's sortable starts a drag only after the pointer has moved.
  for (const dy of [5, 15, 40]) await page.mouse.move(from!.x + from!.width / 2, from!.y - dy, { steps: 3 });
  await page.mouse.move(to!.x + 20, to!.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect(rows.nth(0).locator('.schPlaylist')).toHaveValue(PL[2]);
  await save(page);
  expect(await names(request)).toEqual([PL[2], PL[0], PL[1]]);

  // fppd runs it in that order too.
  await expect.poll(async () => ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
    .map((e: any) => e.playlist), { timeout: 10_000 }).toEqual([PL[2], PL[0], PL[1]]);
});

test('a schedule fppd will not reload says so, not just "Schedule saved"', async ({ page, request }) => {
  // Regression: 38661b107.  SaveSchedule() reported the save, then asked fppd to reload
  // with no error handler (and api/schedule/reload answered OK even when
  // fppd didn't): with fppd stopped, the page said "Schedule saved" and
  // nothing else, and the player kept running its old schedule.
  const rows = await openPage(page, request, [entry(PL[0])]);
  await page.route('**/api/schedule/reload', (route) => route.fulfill({ status: 500, body: 'fppd is not running' }));
  await rows.nth(0).locator('.schPlaylist').selectOption(PL[1]);
  await save(page);
  const growl = page.locator('#jGrowl');
  await expect(growl).toContainText('Schedule saved');
  expect(await names(request)).toEqual([PL[1]]);
  const dialog = page.locator('.modal.show', { hasText: 'Schedule Not Reloaded' });
  await expect(dialog).toBeVisible({ timeout: 3000 });
  await expect(dialog).toContainText('did not confirm the reload');
});
