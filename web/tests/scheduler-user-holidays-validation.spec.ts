import { test, expect } from './fixtures';

// The scheduler's holiday editor refuses a holiday with a config name but no
// display name (a display name alone gets a config name made from it when
// the field loses focus): the field is marked, nothing is saved, and the
// notice is shown as an error (jGrowl's "danger" state, class
// ui-state-danger, which the theme colours red).
//
// Regression: fpp 0be281d24.  The notice asked for themeState 'danager', so
// it came up as class ui-state-danager, which nothing styles: a plain notice
// for an error.

test('a holiday with no display name is refused with an error notice', async ({ page, request }) => {
  const saved = await (await request.get('/api/configfile/user-holidays.json')).text();
  await page.goto('/scheduler.php');
  const modal = page.locator('#holidayEditorModal');
  const shown = modal.evaluate((el) => new Promise<void>((r) => el.addEventListener('shown.bs.modal', () => r(), { once: true })));
  await page.evaluate(() => (window as any).OpenHolidayEditor());
  await shown;
  await modal.getByRole('button', { name: 'Add Holiday' }).click();
  const row = modal.locator('#tblUserHolidaysBody tr').last();
  await row.locator('.holShortName').fill('fpptestsday');
  await modal.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(row.locator('.holName')).toHaveClass(/is-invalid/);
  const notice = page.locator('.jGrowl-notification', { hasText: 'Please correct the highlighted fields' });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/(^|\s)ui-state-danger(\s|$)/);
  // Refused: the holidays file is as it was.
  expect(await (await request.get('/api/configfile/user-holidays.json')).text()).toBe(saved);
});
