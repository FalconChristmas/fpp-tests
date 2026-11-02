import { test, expect } from './fixtures';

// Regression: c626c6029.  The red "Top" button floats at the top right of a
// scrolled page, above everything (z-index 9999), which is where a dialog's
// close button is: with a dialog open it sat on top of the close button.  Page
// scrolling is locked while a dialog is open, so the button is hidden then and
// comes back when the dialog closes.

test('the Top button is hidden while a dialog is open and back after it closes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('/settings.php');
  await page.waitForFunction(() => typeof (window as any).DoModalDialog === 'function' && document.readyState === 'complete');
  // The page scrolls itself to the top once, shortly after it loads.
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const top = page.locator('#scrollTopButton');
  await expect(top).toBeVisible();

  await page.evaluate(() => (window as any).DoModalDialog({
    id: 'scrollTopProbe', title: 'Probe', body: '<p>Probe</p>', backdrop: true, keyboard: true,
    buttons: { Close: { id: 'scrollTopProbeClose', click: () => (window as any).CloseModalDialog('scrollTopProbe') } },
  }));
  await expect(page.locator('#scrollTopProbe.show')).toBeVisible();
  // A modal ignores a hide asked for while it is still fading in.
  await page.waitForTimeout(500);
  await expect(top).toBeHidden();

  await page.locator('#scrollTopProbeClose').click();
  await expect(page.locator('#scrollTopProbe')).toBeHidden();
  await expect(top).toBeVisible();
});
