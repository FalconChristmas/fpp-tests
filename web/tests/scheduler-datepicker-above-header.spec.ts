import { expect, test } from './fixtures';

// Regression: cebe318b4.  jQuery UI gives its datepicker popup a z-index one
// above its input's, which is about 1 for an input in a table cell, so on the
// Scheduler the calendar slid under the sticky table header (z-index 990)
// when it opened upward over it, hiding its top rows.

test('a schedule entry\'s calendar opens above the sticky table header', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 520 });
  await page.goto('/scheduler.php');
  const add = page.locator('button[onclick="AddScheduleEntry();"]').first();
  for (let i = 0; i < 8; i++) await add.click();
  const rows = page.locator('#tblScheduleBody > tr');
  await expect(rows).toHaveCount(8);

  // The last row, scrolled to the bottom: the calendar has no room below its
  // input, so it opens upward over the header stuck at the top of the window.
  const input = rows.last().locator('input.schStartDate');
  await input.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await input.click();
  const picker = page.locator('#ui-datepicker-div');
  await expect(picker).toBeVisible();

  const hit = await page.evaluate(() => {
    const p = document.getElementById('ui-datepicker-div')!.getBoundingClientRect();
    const head = Array.from(document.querySelectorAll('.floatThead-container'))
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0 && r.bottom > p.top && r.top < p.bottom);
    if (!head.length) return { overlap: false, inside: true };
    const r = head[0];
    const x = Math.min(Math.max(r.left + r.width / 2, p.left + 5), p.right - 5);
    const y = (Math.max(r.top, p.top) + Math.min(r.bottom, p.bottom)) / 2;
    const el = document.elementFromPoint(x, y);
    return { overlap: true, inside: !!el && !!el.closest('#ui-datepicker-div') };
  });
  expect(hit.overlap, 'the calendar should open over the sticky header for this test to mean anything').toBe(true);
  expect(hit.inside, 'the sticky header is drawn over the calendar').toBe(true);
});
