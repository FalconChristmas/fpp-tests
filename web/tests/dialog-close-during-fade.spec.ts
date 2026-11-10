import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// CloseModalDialog() in fpp.js.  Bootstrap's Modal.hide() does nothing while
// the dialog is still fading in, so a dialog closed by work that finished
// inside the fade (a quick save, a fast lookup) stayed open: seen first as
// the script editor staying up after Save (filemanager-editors.spec.ts).
// The close now waits for the dialog to be shown, and only closes the
// dialog it was asked to: DoModalDialog() makes a new instance each time an
// id is opened, and one opened again in the meantime stays open (f9c20b37f).

const settled = (page: Page, id: string) =>
  page.waitForFunction((i) => {
    const m = (window as any).bootstrap.Modal.getInstance(document.getElementById(i));
    return !m || !m._isTransitioning;
  }, id);

const open = (page: Page, id: string, body: string) =>
  page.evaluate(([i, b]) => (window as any).DoModalDialog({ id: i, title: 'fpp-tests', body: b, class: 'modal-sm',
    keyboard: true, backdrop: true, buttons: { Close: () => (window as any).CloseModalDialog(i) } }), [id, body]);

test.beforeEach(async ({ page }) => {
  await page.goto('/index.php');
});

test('a dialog closed while it is still fading in closes once it is shown', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).DoModalDialog({ id: 'fppTestsFade', title: 'fpp-tests', body: 'quick', buttons: {} });
    (window as any).CloseModalDialog('fppTestsFade');
  });
  await expect(page.locator('#fppTestsFade')).toBeHidden();
  await settled(page, 'fppTestsFade');
  await expect(page.locator('body')).not.toHaveClass(/modal-open/);
});

test('a dialog closed in its fade and opened again straight away stays open', async ({ page }) => {
  // The close is put off until the first open is shown; by then the id has
  // been opened again, and that open must not be the one closed.
  await page.evaluate(() => {
    const w = window as any;
    w.DoModalDialog({ id: 'fppTestsAgain', title: 'fpp-tests', body: 'first', buttons: {} });
    w.CloseModalDialog('fppTestsAgain');
    w.DoModalDialog({ id: 'fppTestsAgain', title: 'fpp-tests', body: 'second', buttons: {} });
  });
  const dialog = page.locator('#fppTestsAgain');
  await expect(dialog).toContainText('second');
  await settled(page, 'fppTestsAgain');
  await page.waitForTimeout(800);
  await expect(dialog).toBeVisible();
});

test('a dialog closed and then opened again after its fade opens normally', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.DoModalDialog({ id: 'fppTestsLater', title: 'fpp-tests', body: 'first', buttons: {} });
    w.CloseModalDialog('fppTestsLater');
  });
  const dialog = page.locator('#fppTestsLater');
  await expect(dialog).toBeHidden();
  await settled(page, 'fppTestsLater');
  await open(page, 'fppTestsLater', 'second');
  await expect(dialog).toContainText('second');
  await settled(page, 'fppTestsLater');
  await page.waitForTimeout(800);
  await expect(dialog).toBeVisible();
  await dialog.locator('.modal-footer button', { hasText: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

test('a dialog closed after it is shown closes at once, and closing one that is not there does nothing', async ({ page }) => {
  await open(page, 'fppTestsShown', 'shown');
  const dialog = page.locator('#fppTestsShown');
  await expect(dialog).toBeVisible();
  await settled(page, 'fppTestsShown');
  await page.evaluate(() => (window as any).CloseModalDialog('fppTestsShown'));
  await expect(dialog).toBeHidden();

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => (window as any).CloseModalDialog('fppTestsNoSuchDialog'));
  await page.waitForTimeout(200);
  expect(errors).toEqual([]);
});

test('an fppDialog closed while it is still fading in closes once it is shown', async ({ page }) => {
  // $.fn.fppDialog('close') still calls Bootstrap's hide() straight away, so
  // the dialogs closed that way (the If editor's Edit Condition and its
  // evaluation popup, among others) stay open when closed inside the fade.
  // In FUTURE.md.
  test.fail(true, "fppDialog('close') does not wait for the fade (FUTURE.md)");
  await page.evaluate(() => {
    const $ = (window as any).$;
    $("<div id='fppTestsJqFade'>quick</div>").appendTo('body').fppDialog({ title: 'fpp-tests', modal: true, buttons: {} });
    $('#fppTestsJqFade').fppDialog('close');
  });
  await settled(page, 'fppTestsJqFade');
  await expect(page.locator('#fppTestsJqFade')).toBeHidden({ timeout: 2000 });
});

test('an fppDialog closed after it is shown closes', async ({ page }) => {
  // The control for the test above.
  await page.evaluate(() => (window as any).$("<div id='fppTestsJqShown'>shown</div>").appendTo('body')
    .fppDialog({ title: 'fpp-tests', modal: true, buttons: {} }));
  await expect(page.locator('#fppTestsJqShown')).toBeVisible();
  await settled(page, 'fppTestsJqShown');
  await page.evaluate(() => (window as any).$('#fppTestsJqShown').fppDialog('close'));
  await expect(page.locator('#fppTestsJqShown')).toBeHidden();
});
