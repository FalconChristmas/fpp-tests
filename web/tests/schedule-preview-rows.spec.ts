import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// What the schedule preview (schedulePreview.php) says each playlist start
// will do, from fppd's own schedule (/fppd/schedule): which playlist, how it
// repeats and stops, and whether it starts at all.  fppd gives each entry a
// priority from its place in the schedule (the first is 0, the highest), and
// does not start a playlist while a higher-priority one is running.

const SHOW = 'fpp-tests-preview-show';
const FILLER = 'fpp-tests-preview-filler';

test.describe('schedule preview rows', () => {
  let before: unknown;
  const year = new Date().getFullYear();
  // Every day, so the preview has rows whatever today is.
  const daily = (playlist: string, start: string, end: string, repeat: number, stopType: number) => ({
    enabled: 1, day: 7, playlist, startTime: start, endTime: end,
    startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat, stopType,
  });

  async function preview(page: Page, request: APIRequestContext, schedule: { playlist: string }[]) {
    const playlists = schedule.map((e) => e.playlist);
    const sch = await request.post('/api/schedule', { data: schedule });
    expect(sch.ok()).toBe(true);
    await request.post('/api/schedule/reload');
    // Wait for fppd to have this schedule, not the previous one: each
    // playlist at the priority its place gives it.
    await expect.poll(async () => {
      const items = (await (await request.get('/api/fppd/schedule')).json()).schedule.items;
      return [...new Set(items.map((i: { args: string[]; priority: number }) => `${i.args[0]}:${i.priority}`))].sort();
    }, { timeout: 10_000 }).toEqual(playlists.map((p, i) => `${p}:${i}`).sort());
    await page.goto('/schedulePreview.php');
    await expect(page.locator('table.schedulePreviewTable tbody tr').first()).toBeVisible();
    return page.locator('table.schedulePreviewTable tbody tr');
  }

  test.beforeEach(async ({ request }) => {
    before = await (await request.get('/api/schedule')).json();
    for (const name of [SHOW, FILLER]) {
      await request.delete(`/api/playlist/${name}`);
      const pl = await request.post(`/api/playlist/${name}`, {
        data: { name, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
      });
      expect(pl.ok()).toBe(true);
    }
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    for (const name of [SHOW, FILLER]) await request.delete(`/api/playlist/${name}`);
  });

  test("a start row names the playlist, how it repeats and how it stops", async ({ page, request }) => {
    // Regression: 0eb2b9207.  The start row's printf was handed a stray
    // $holiday ahead of the playlist name, so every argument after it moved
    // up one: the row read "<blank> (<playlist> w/ Repeating Stop)".
    const rows = await preview(page, request, [daily(SHOW, '18:00:00', '22:00:00', 1, 1)]);
    const start = rows.filter({ hasText: 'Start Playing' }).first();
    await expect(start).toContainText(`${SHOW} (Repeating w/ Hard Stop)`);
  });

  test('a playlist that starts inside a higher-priority one is marked as skipped', async ({ page, request }) => {
    // Regression: 3cf935973.  The preview listed every start as "Start
    // Playing", though fppd will not start a lower-priority playlist while a
    // higher-priority one runs; it is now "Skip Start Playing - Lower
    // Priority", in red, and each item's info gives its priority.
    const rows = await preview(page, request,
      [daily(FILLER, '17:00:00', '22:00:00', 0, 0), daily(SHOW, '18:00:00', '21:00:00', 0, 0)]);
    const filler = rows.filter({ hasText: FILLER }).filter({ hasText: 'Start Playing' }).first();
    await expect(filler).toContainText(`Start Playing - ${FILLER} (Non-Repeating w/ Graceful Stop)`);
    await expect(filler).not.toContainText('Skip');
    const show = rows.filter({ hasText: SHOW }).first();
    await expect(show).toContainText(`Skip Start Playing - ${SHOW} - Lower Priority`);
    await expect(show.getByText('Skip Start Playing')).toHaveCSS('color', 'rgb(255, 0, 0)');
    // The same pair the other way round: the show, first in the schedule,
    // starts inside the filler.
    const swapped = await preview(page, request,
      [daily(SHOW, '18:00:00', '21:00:00', 0, 0), daily(FILLER, '17:00:00', '22:00:00', 0, 0)]);
    await expect(swapped.filter({ hasText: 'Skip' })).toHaveCount(0);
    await expect(swapped.filter({ hasText: SHOW }).first()).toContainText(`Start Playing - ${SHOW} (Non-Repeating`);
    // Each item's info tooltip gives the priority fppd gave it.
    const tip = await swapped.filter({ hasText: SHOW }).first().locator('[data-bs-toggle="tooltip"]').getAttribute('data-bs-title');
    expect(tip).toContain('<b>Priority:</b> 0');
  });
});
