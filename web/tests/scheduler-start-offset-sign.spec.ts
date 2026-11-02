import { test, expect } from './fixtures';

// Regression: b7852d876.  A schedule row's start-time offset (shown beside
// dawn, sunrise, sunset and dusk) is a number of minutes that may be negative
// (min -120), but the field was drawn after a literal "+", so an offset of
// -30 read "+-30".

test('the start time offset is not labelled with a plus sign', async ({ page }) => {
  await page.goto('/scheduler.php');
  await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
  const row = page.locator('#tblScheduleBody > tr').last();
  await row.locator('.schStartTime').fill('Sunrise');
  await row.locator('.schStartTime').press('Tab');
  const offset = row.locator('.startOffset');
  await expect(offset).toBeVisible();
  const input = offset.locator('.schStartTimeOffset');
  // The control: it still takes a negative offset.
  await expect(input).toHaveAttribute('min', '-120');
  const text = (await offset.evaluate((e) => e.textContent ?? '')).trim();
  expect(text, 'the label around the start offset').not.toContain('+');
  expect(text).toBe('min');
});
