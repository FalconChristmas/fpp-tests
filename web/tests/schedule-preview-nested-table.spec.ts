import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Scheduler's "Preview > Nested Table View" (schedulePreview.php): what
// fppd has queued to run (api/fppd/schedule, the next ScheduleDistance days),
// drawn as a Start Playing and an End Playing row per playlist, nested while
// another playlist runs, a lower priority playlist that starts inside a higher
// one marked as skipped, and each command with its arguments.
// (schedule-preview-scroll.spec.ts: the dialog's scrolling.)

const A = 'fpp-tests-prev-a';
const B = 'fpp-tests-prev-b';
let before: unknown;

const year = new Date().getFullYear();
const entry = (playlist: string, extra: object = {}) => ({
  enabled: 1, day: 7, type: 'playlist', playlist, command: '', args: [],
  startTime: '12:00:00', endTime: '13:00:00',
  startDate: `${year - 1}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0, ...extra,
});

test.beforeEach(async ({ request }) => {
  before = await (await request.get('/api/schedule')).json();
  for (const name of [A, B]) {
    const r = await request.post(`/api/playlist/${encodeURIComponent(name)}`, {
      data: { name, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(r.ok()).toBe(true);
  }
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: before });
  await request.post('/api/schedule/reload');
  for (const name of [A, B]) await request.delete(`/api/playlist/${encodeURIComponent(name)}`);
});

// fppd reloads lazily: wait until it has queued items from the new schedule.
async function useSchedule(request: APIRequestContext, entries: object[]) {
  expect((await request.post('/api/schedule', { data: entries })).ok()).toBe(true);
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
  const want = entries.map((e: any) => e.playlist || e.command);
  await expect.poll(async () =>
    ((await (await request.get('/api/fppd/schedule')).json()).schedule?.entries ?? [])
      .map((e: any) => e.playlist || e.command), { message: 'the control: fppd runs the schedule', timeout: 10_000 })
    .toEqual(want);
}

async function openPreview(page: Page) {
  await page.goto('/scheduler.php');
  await page.locator('#schedulerPreviewActions').click();
  await page.locator('.dropdown-menu.show .dropdown-item', { hasText: 'Nested Table View' }).click();
  const dialog = page.locator('#schedulePreview');
  await expect(dialog).toBeVisible();
  return dialog;
}

// A row's text with its cells' spacing squeezed out.
const texts = async (dialog: ReturnType<Page['locator']>) =>
  (await dialog.locator('.schedulePreviewTable tbody tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);

test('a playlist has a Start Playing and an End Playing row, with how it repeats and stops', async ({ page, request }) => {
  await useSchedule(request, [entry(A, { repeat: 1, stopType: 1 })]);
  const rows = await texts(await openPreview(page));
  expect(rows.some((t) => t.includes(`Start Playing - ${A} (Repeating w/ Hard Stop)`)), rows.slice(0, 4).join('\n')).toBe(true);
  expect(rows.some((t) => t.includes(`End Playing - ${A} (Hard Stop)`)), rows.slice(0, 4).join('\n')).toBe(true);
  // Every start has its end, one after the other.
  const starts = rows.filter((t) => t.includes('Start Playing')).length;
  expect(starts).toBeGreaterThan(0);
  expect(rows.filter((t) => t.includes('End Playing')).length).toBe(starts);
  expect(rows.findIndex((t) => t.includes('Start Playing'))).toBeLessThan(rows.findIndex((t) => t.includes('End Playing')));
});

test('a lower priority playlist starting inside a higher one is shown as skipped', async ({ page, request }) => {
  await useSchedule(request, [entry(A, { endTime: '14:00:00' }), entry(B, { startTime: '13:00:00', endTime: '13:30:00' })]);
  const dialog = await openPreview(page);
  const rows = await texts(dialog);
  expect(rows.some((t) => t.includes(`Skip Start Playing - ${B} - Lower Priority`)), rows.slice(0, 6).join('\n')).toBe(true);
  expect(rows.some((t) => t.includes(`Start Playing - ${A}`) && !t.includes('Skip')), rows.slice(0, 6).join('\n')).toBe(true);
  // A is never the one skipped.
  expect(rows.some((t) => t.includes(`Skip Start Playing - ${A}`))).toBe(false);
  await expect(dialog.locator('td', { hasText: 'Skip Start Playing' }).first()).toHaveCSS('color', 'rgb(255, 0, 0)');
});

test('a command is listed with its arguments, between the playlists around it', async ({ page, request }) => {
  await useSchedule(request, [
    entry(A),
    entry('', { type: 'command', command: 'Volume Set', args: ['40'], startTime: '12:30:00', endTime: '12:30:00' }),
  ]);
  const rows = await texts(await openPreview(page));
  const start = rows.findIndex((t) => t.includes(`Start Playing - ${A}`));
  const cmd = rows.findIndex((t) => t.includes('Volume Set - 40'));
  const end = rows.findIndex((t) => t.includes(`End Playing - ${A}`));
  expect([start, cmd, end].every((i) => i >= 0), rows.slice(0, 6).join('\n')).toBe(true);
  expect(start).toBeLessThan(cmd);
  expect(cmd).toBeLessThan(end);
});

test('an empty schedule says Nothing Scheduled', async ({ page, request }) => {
  expect((await request.post('/api/schedule', { data: [] })).ok()).toBe(true);
  expect((await request.post('/api/schedule/reload')).ok()).toBe(true);
  await expect.poll(async () => ((await (await request.get('/api/fppd/schedule')).json()).schedule?.items ?? []).length,
    { timeout: 10_000 }).toBe(0);
  const dialog = await openPreview(page);
  await expect(dialog).toContainText('Nothing Scheduled.');
  await expect(dialog.locator('.schedulePreviewTable')).toHaveCount(0);
});
