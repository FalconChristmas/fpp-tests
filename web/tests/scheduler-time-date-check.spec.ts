import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The scheduler's start/end time and date boxes are free text.  A time that is
// neither a clock time nor dawn/sunrise/sunset/dusk is put back to midnight,
// and a date that is neither YYYY-MM-DD nor a holiday becomes the end of the
// range (<MAXYEAR>-12-31), so nothing fppd can't read is saved.
//
// Regression: 30d2b8a55 ("Prevent invalid times/dates from being scheduled",
// #1343).  Whatever was typed was kept and saved.

const year = new Date().getFullYear();
let saved: unknown;

test.beforeEach(async ({ request }) => {
  saved = await (await request.get('/api/schedule')).json();
  const entry = {
    enabled: 1, day: 7, type: 'playlist', playlist: 'fpp-tests-sched', startTime: '19:00:00', endTime: '20:00:00',
    startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`, repeat: 0, stopType: 0,
  };
  expect((await request.post('/api/schedule', { data: [entry] })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/schedule', { data: saved });
});

async function type(page: Page, selector: string, value: string) {
  const input = page.locator(`#tblScheduleBody > tr ${selector}`).first();
  // As the browser does when the box loses focus: a bubbling change event,
  // which both the page's onChange and the time picker's own handler see.
  await input.evaluate((el: HTMLInputElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  return input;
}

test('a time or date the scheduler cannot read is replaced, a good one is kept', async ({ page }) => {
  await page.goto('/scheduler.php');
  await expect(page.locator('#tblScheduleBody > tr')).toHaveCount(1);
  const maxYear = await page.evaluate(() => (window as any).MAXYEAR);

  // The control: a sun time and a real date are left as typed.
  await expect(await type(page, '.schStartTime', 'Sunset')).toHaveValue('Sunset');
  await expect(await type(page, '.schEndDate', `${year + 2}-06-30`)).toHaveValue(`${year + 2}-06-30`);

  // 0:00:00, which the time picker then shows as midnight in the page's
  // time format.
  await expect(await type(page, '.schStartTime', 'after tea')).toHaveValue(/^(0?0:00(:00)?|12:00 AM)$/);
  await expect(await type(page, '.schEndDate', 'next summer')).toHaveValue(`${maxYear}-12-31`);
});
