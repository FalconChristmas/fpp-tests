import { test, expect } from './fixtures';

// The scheduler page sets up its date pickers on the rows it loads, and a
// row added afterwards has to get its own: 27f26c3cb.  Without it the Start
// and End Date boxes of a new row are bare text boxes.  Nothing here is
// saved, so the stored schedule isn't touched.

test('a schedule row added on the page has a working date picker', async ({ page }) => {
  // Feature: 27f26c3cb (SetupDatePicker(row) in AddScheduleEntry).
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/schedule');
  await page.goto('/scheduler.php');
  await loaded;
  const rows = page.locator('#tblScheduleBody > tr');
  await expect.poll(() => page.evaluate(() => typeof (window as any).AddScheduleEntry)).toBe('function');
  const before = await rows.count();

  await page.locator('button[onclick="AddScheduleEntry();"]').first().click();
  await expect(rows).toHaveCount(before + 1);

  const start = rows.last().locator('input.schStartDate');
  await start.click();
  const picker = page.locator('#ui-datepicker-div');
  await expect(picker, 'the new row has no date picker').toBeVisible();
  await picker.locator('.ui-datepicker-calendar a', { hasText: /^15$/ }).click();
  await expect(start).toHaveValue(/^\d{4}-\d{2}-15$/);
  await expect(picker).toBeHidden();
});
