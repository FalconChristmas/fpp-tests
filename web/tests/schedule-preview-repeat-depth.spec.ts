import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The schedule preview (schedulePreview.php) indents overlapping playlists
// into extra columns, and a first pass sizes the table for the deepest
// overlap.  That pass disagreed with the one drawing the rows twice over:
//  - it counted a playlist as still running when the next one started at the
//    second it ended, so once a repeating entry's occurrences ended on the
//    boundary (fpp #3141) every hourly entry gained an empty indent column;
//  - it closed one level per end time, not one per playlist ending then, so
//    every evening on which two playlists ended together added a column.
// Both fixed in fpp 0577f3c90 (the #3141 commit).

const PLAYLIST = 'fpp-tests-preview-depth';

async function previewSpacers(page: Page, request: APIRequestContext, schedule: object[]) {
  const sch = await request.post('/api/schedule', { data: schedule });
  expect(sch.ok()).toBe(true);
  await request.post('/api/schedule/reload');
  await expect.poll(async () =>
    (await (await request.get('/api/fppd/schedule')).json()).schedule.items.length,
  { timeout: 10_000 }).toBeGreaterThan(2);

  await page.goto('/schedulePreview.php');
  const head = page.locator('table.schedulePreviewTable thead tr').first();
  await expect(head).toBeVisible();
  // One spacer cell per indent level, plus one.
  return head.locator('td');
}

test.describe('schedule preview indent columns', () => {
  let before: unknown;
  const year = new Date().getFullYear();
  // Every day, so the preview has rows whatever today is.
  const daily = (start: string, end: string, repeat: number) => ({
    enabled: 1, day: 7, playlist: PLAYLIST, startTime: start, endTime: end,
    startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat, stopType: 1,
  });

  test.beforeEach(async ({ request }) => {
    await request.delete(`/api/playlist/${PLAYLIST}`);
    before = await (await request.get('/api/schedule')).json();
    const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
      data: { name: PLAYLIST, version: 4, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(pl.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
    await request.delete(`/api/playlist/${PLAYLIST}`);
  });

  test('an hourly entry gets no indent column', async ({ page, request }) => {
    const cells = await previewSpacers(page, request, [daily('20:00:00', '23:00:00', 6000)]);
    await expect(cells).toHaveCount(1);
  });

  test('two playlists ending together each night need one indent column', async ({ page, request }) => {
    // A show over a filler, both ending at 22:00: one level of overlap,
    // however many days the preview covers.
    const cells = await previewSpacers(page, request,
      [daily('18:00:00', '22:00:00', 0), daily('17:00:00', '22:00:00', 0)]);
    await expect(cells).toHaveCount(2);
  });
});
