import { expect, test } from './fixtures';

// fpp 48f409703 ("fix(scheduler): Datepicker selected date invisible in light
// mode"): the light theme's white .ui-state-active fill, meant for the active
// tab, also matched the datepicker's selected day, which keeps jQuery UI's
// white text, so a schedule entry's chosen date showed as a blank cell when
// its calendar was reopened.

function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('a schedule entry\'s selected date is readable in its datepicker in light mode', async ({ page, request }) => {
  await request.put('/api/settings/themeOverride', { data: 'light' });
  await page.goto('/scheduler.php');
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'light');
  await page.locator('button[onclick="AddScheduleEntry();"]').first().click();

  // Pick a day of the shown month that isn't today, so the cell is
  // "selected" and not also "today"; then reopen the picker, as the user did.
  const day = new Date().getDate() === 15 ? 16 : 15;
  const input = page.locator('#tblScheduleBody input.schStartDate').first();
  const picker = page.locator('#ui-datepicker-div');
  await input.click();
  await picker.locator('td[data-handler="selectDay"]:not(.ui-datepicker-other-month) a')
    .getByText(String(day), { exact: true }).click();
  await expect(input).toHaveValue(new RegExp(`-${day}$`));
  await page.locator('h1.title').first().click();
  await expect(picker).toBeHidden();
  await input.click();

  const selected = picker.locator('td a.ui-state-active');
  await expect(selected).toBeVisible();
  await expect(selected).toHaveText(String(day));
  const { color, background } = await selected.evaluate((el) => {
    // The first opaque fill from the cell up: a transparent one shows its parent's.
    let bg = 'rgb(255, 255, 255)';
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (!/^rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') {
        bg = c;
        break;
      }
    }
    return { color: getComputedStyle(el).color, background: bg };
  });
  expect(contrast(color, background), `text ${color} on ${background}`).toBeGreaterThanOrEqual(3);
});
