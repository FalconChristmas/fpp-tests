import { test, expect } from './fixtures';

// Two small scheduler page behaviours with times.

const PLAYLIST = 'fpp-tests-sched-times';

test.beforeEach(async ({ request }) => {
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

test('a one-digit hour is a clock time, not a sun time with an offset', async ({ page }) => {
  // Regression: 55e33cb9f.  "6:00:00" did not match the pattern for a clock
  // time, so the row offered a minutes offset beside it as if it were dawn.
  await page.goto('/scheduler.php');
  await expect(page.locator('.fppTableRowTemplate .schPlaylist option', { hasText: PLAYLIST })).toHaveCount(1);
  await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
  const row = page.locator('#tblScheduleBody > tr').last();
  const start = row.locator('.schStartTime');
  for (const t of ['6:00:00', '6:00', '06:00:00']) {
    await start.fill(t);
    await start.press('Tab');
    await expect(row.locator('.startOffset'), `offset beside ${t}`).toBeHidden();
  }
});

test('opening the scheduler turns on seconds when an entry has seconds', async ({ page, request }) => {
  // Regression: 3e461d672.  ScheduleSeconds, new in 5.0, is set by the page
  // from the entries: any with a non-zero seconds part turns it on.
  const before = await (await request.get('/api/schedule')).json();
  const year = new Date().getFullYear();
  try {
    await request.put('/api/settings/ScheduleSeconds', { data: '' });
    await request.post('/api/schedule', { data: [{
      enabled: 1, day: 7, playlist: PLAYLIST, startTime: '18:00:30', endTime: '19:00:00',
      startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0 }] });
    await page.goto('/scheduler.php');
    await expect.poll(async () => (await (await request.get('/api/settings/ScheduleSeconds')).json()).value,
      { timeout: 10_000 }).toBe('1');
    await expect(page.locator('#tblScheduleBody > tr').first().locator('.schStartTime')).toHaveValue(/:00:30/);
  } finally {
    await request.post('/api/schedule', { data: before });
    await request.post('/api/schedule/reload');
  }
});
