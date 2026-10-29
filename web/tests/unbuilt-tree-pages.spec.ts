import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingFile } from './privacy-helpers';

// A tree that was never built, or was cleaned (make clean), has no fppd and
// no generated www/fppversion.php: the pages fall back to
// fppunknown_versions.php for the version, and the header offers a rebuild
// (menu.inc's rebuild popup, rendered when src/fppd is missing).  The pages
// must still work, so the user can start that rebuild from them.

test.skip(!container, 'removes files from the tree in the run-web.sh container');

const VERSION = '/opt/fpp/www/fppversion.php';
const FPPD = '/opt/fpp/src/fppd';

test('a cleaned tree still draws the pages, with the menu, and runs their scripts', async ({ page, request }) => {
  // Regression: 0b080ba09.  The rebuild popup's <textarea> had lost its
  // closing tag, so everything after it on the page -- the whole menu --
  // became the textarea's text; and the unknown patch version, "Unknown",
  // was written into config.php's script as `FPP_PATCH_VERSION = Unknown;`,
  // a ReferenceError that stopped the page's setup script.
  const branch = async () => (await (await request.get('/api/system/info?simple=1')).json()).Branch;
  const was = await branch();
  // fppd keeps running from the renamed binary; it is only moved aside.
  inPlayer('mv', FPPD, `${FPPD}.fpp-tests-aside`);
  try {
    await keepingFile(VERSION, async () => {
      inPlayer('rm', '-f', VERSION);
      // (php-fpm's opcache notices within a few seconds.)
      await expect.poll(branch, { message: 'the control: the version is unknown', timeout: 15_000 }).toBe('Unknown');
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto('/index.php');
      // The control: the rebuild popup is on the page.
      await expect(page.locator('#rebuildPopup')).toHaveCount(1);
      await expect(page.locator('#rebuildText')).toHaveValue(/^\s*$/);
      await expect(page.locator('#fppMenuList')).toHaveCount(1);
      await expect(page.locator('#navbarDropdownMenuLinkStatus')).toBeAttached();

      await page.waitForLoadState('load');
      expect(await page.evaluate(() => (window as any).FPP_PATCH_VERSION)).toBe(0);
      expect(await page.evaluate(() => (window as any).FPP_FULL_VERSION)).toBe('Unknown');
      expect(errors).toEqual([]);
    });
  } finally {
    inPlayer('mv', `${FPPD}.fpp-tests-aside`, FPPD);
    await expect.poll(branch, { timeout: 15_000 }).toBe(was);
  }
});
