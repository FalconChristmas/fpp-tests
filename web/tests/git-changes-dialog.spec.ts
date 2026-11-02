import { test, expect } from './fixtures';

// The Git Changes dialog (GetGitOriginLog in fpp.js): the commits origin has
// that this checkout does not, opened from the System Upgrade page.

test('the Git Changes dialog can be closed, from its header and its Close button', async ({ page }) => {
  // Regression: 115223099.  The dialog was opened with noClose, which
  // disables the header's close button, so what was left to close it was the
  // footer's button, and the first attempt to fix #1521 only hid that.
  await page.route('**/api/git/originLog**', (r) => r.fulfill({ json: { status: 'OK', rows: [
    { hash: 'a'.repeat(40), author: 'Pat Tester', date: '2026-03-04', msg: 'fix: something' }] } }));
  await page.goto('/index.php');
  await page.evaluate(() => (window as any).GetGitOriginLog());
  const dlg = page.locator('#GitOriginLogView');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('fix: something');
  await expect(dlg.locator('#modalCloseButton')).toBeEnabled();
  await dlg.locator('#modalCloseButton').click();
  await expect(dlg).toBeHidden();

  await page.evaluate(() => (window as any).GetGitOriginLog());
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('#GitOriginLogViewCloseButton')).toBeEnabled();
  await dlg.locator('#GitOriginLogViewCloseButton').click();
  await expect(dlg).toBeHidden();
});
