import { test, expect } from './fixtures';

// Regression: 6363fa249 ("Fix issue with offset showing when not
// dawn/sunrise/sunset/dusk").  A schedule row's start and end time carry a
// minutes offset that only means something for a sun-based time.  The page
// showed it for anything that was not a clock time, so a row with no time
// yet offered an offset beside it.

const PLAYLIST = 'fpp-tests-sched-offset';

test.beforeEach(async ({ request }) => {
  const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
    data: { name: PLAYLIST, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(pl.ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${PLAYLIST}`);
});

test('a time offset shows only beside dawn, sunrise, sunset or dusk', async ({ page }) => {
  await page.goto('/scheduler.php');
  await expect(page.locator('.fppTableRowTemplate .schPlaylist option', { hasText: PLAYLIST })).toHaveCount(1);
  await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
  const row = page.locator('#tblScheduleBody > tr').last();
  const start = row.locator('.schStartTime');
  const offset = row.locator('.startOffset');

  // A row with no time has no offset.
  await page.evaluate(() => {
    const r = $('#tblScheduleBody > tr').last();
    r.find('.schStartTime').val('');
    (window as any).SetRowDateTimeFieldVisibility(r);
  });
  await expect(start).toHaveValue('');
  await expect(offset, 'offset beside an empty time').toBeHidden();

  // The control: a sun time shows it, and a clock time takes it away again.
  for (const sun of ['Dawn', 'sunrise', 'Sunset', 'DUSK']) {
    await start.fill(sun);
    await start.press('Tab');
    await expect(offset, `offset beside ${sun}`).toBeVisible();
    await page.evaluate(() => (window as any).SetRowDateTimeFieldVisibility($('#tblScheduleBody > tr').last()));
    await expect(offset, `offset beside ${sun} after a refresh`).toBeVisible();
  }
  await start.fill('19:30');
  await start.press('Tab');
  await expect(offset, 'offset beside a clock time').toBeHidden();

  // The end time has its own.
  const end = row.locator('.schEndTime');
  await end.fill('Sunset');
  await end.press('Tab');
  await expect(row.locator('.endOffset')).toBeVisible();
  await end.fill('21:00');
  await end.press('Tab');
  await expect(row.locator('.endOffset')).toBeHidden();
});
