import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Two more places that put text into the page as markup, fixed in fpp
// 816f681de ("fix(js): stored/reflected XSS in warnings banner, warning help
// dialogs, and Ping dialog (#3105)"):
//   - the Ping dialog put the address it was asked to ping into its title and
//     its error text as markup;
//   - the crash-report warning carried its File Manager link as markup in the
//     message, which the (by then escaped) banner showed as literal text; it
//     is a Fix button now.

test('the Ping dialog shows the address as text', async ({ page }) => {
  const address = '<img src=x onerror=window.__fppTestsPing=1>';
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).PingIP === 'function');
  await page.evaluate((ip) => (window as any).PingIP(ip, 1), address);
  const title = page.locator('.modal.show .modal-title');
  await expect(title).toContainText(address);
  // Let the ping's answer land too, error text included.
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => (window as any).__fppTestsPing)).toBeUndefined();
});

test.describe('crash reports', () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

  test('the crash-report warning links to the File Manager with a Fix button', async ({ page }) => {
    // Also e9eb6ea23: the warning is also in the status's warningInfo, which
    // is what puts it in the banner (without it the banner has no crash
    // warning at all).
    // Also 13e75564b: the File Manager is filemanager.php (it was
    // uploadfile.php), and the pages that link to it say so.
    const report = '/home/fpp/media/crashes/fpp-tests-crash.zip';
    inPlayer('sh', '-c', `mkdir -p /home/fpp/media/crashes && echo x > ${report}`);
    try {
      await page.goto('/index.php');
      const banner = page.locator('#warningsDiv');
      await expect(banner).toContainText('crash report', { timeout: 15_000 });
      await expect(banner).not.toContainText('<a href');
      await expect(banner.locator('a.warning-fix-btn[href="filemanager.php#tab-crashes"]')).toHaveCount(1);
    } finally {
      inPlayer('rm', '-f', report);
    }
  });
});
