import { expect, test } from './fixtures';

// The Scheduler's date picker for an entry's start and end dates.

test("the date picker's Today button puts today's date in the field", async ({ page }) => {
  // Regression: 54548b77f ("Fix 'Today' button in Scheduler UI date
  // picker").  jQuery UI's own Today button only moves the calendar to the
  // current month and leaves the field as it was; the Scheduler hides it and
  // adds a Today of its own, beside Holidays, that sets the date.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/scheduler.php');
  await page.locator('button[onclick="AddScheduleEntry();"]').first().click();
  const input = page.locator('#tblScheduleBody > tr').last().locator('input.schStartDate');
  await input.fill('2031-07-04');
  await input.click();
  const pane = page.locator('#ui-datepicker-div .ui-datepicker-buttonpane');
  const today = pane.locator('button:visible', { hasText: /^Today$/ });
  await expect(today).toHaveCount(1);
  await expect(pane.locator('button:visible', { hasText: /^Holidays$/ })).toHaveCount(1);
  await today.click();
  const expected = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await expect(input).toHaveValue(expected);
  await expect(page.locator('#ui-datepicker-div')).toBeHidden();
});
