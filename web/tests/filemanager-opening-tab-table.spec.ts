import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The tab File Manager opens on from its URL (filemanager.php#tab-audio) gets
// its Bootstrap Table -- sorting, the filter row, the Items badge -- even when
// its listing arrives before the page has built its tabs.
//
// Regression: b0aaf1bd7.  A listing only set up its table when the table's tab
// was visible, leaving a hidden one to the tabs' activate handler. The tab
// picked from the URL is shown by the tabs' creation, which fires no
// activate, so a listing applied after DOMContentLoaded but before jQuery's
// ready handlers built the tabs (the Audio tab still hidden then) was never
// set up, and clicking the open tab fired nothing either. Seen in the nightly
// as filemanager-badges' filter row never appearing.
//
// The test puts the listing in that window every time: jQuery's ready is held
// (jQuery.holdReady, from a script served after jQuery) and the Music listing
// is answered only once the DOM is parsed; ready is let go once the rows are
// in the plain table.

test.skip(!container, 'seeds a file inside the run-web.sh container');

const MUSIC = '/home/fpp/media/music';
const FILE = 'fpp-tests-opening-tab.mp3';

test.beforeEach(() => {
  inPlayer('sh', '-c', `head -c 1000 /dev/zero > ${MUSIC}/${FILE}`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', `${MUSIC}/${FILE}`);
});

test('the tab the page opens on sets up its table when its listing came before the tabs', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // jquery4-compat.js is the first script after jQuery itself.
  await page.route((u) => u.pathname.endsWith('/js/jquery4-compat.js'), async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, body: (await r.text()) + '\njQuery.holdReady(true);\n' });
  });
  let parsed!: () => void;
  const domParsed = new Promise<void>((resolve) => { parsed = resolve; });
  await page.route((u) => u.pathname.endsWith('/api/files/Music'), async (route) => {
    await domParsed;
    await route.continue();
  });

  await page.goto('/filemanager.php#tab-audio', { waitUntil: 'domcontentloaded' });
  parsed();

  // The listing is in the table, and the tabs are not built yet: the window.
  const table = page.locator('#tblMusic');
  await expect(table.locator('tbody tr').filter({ hasText: FILE })).toHaveCount(1);
  expect(await page.evaluate(() => document.readyState), 'the control: the DOM was parsed').not.toBe('loading');
  expect(await page.locator('#fileManager.ui-tabs').count(), 'the control: the tabs are not built yet').toBe(0);

  await page.evaluate(() => (window as any).jQuery.holdReady(false));
  await expect(page.locator('#fileManager.ui-tabs')).toHaveCount(1);
  // The control: the page opened on the Audio tab.
  await expect(page.locator('#tab-audio')).toBeVisible();
  await expect(page.locator('#tab-audio .bootstrap-table #tblMusic'), 'the Audio table was never set up').toHaveCount(1);
  expect(errors).toEqual([]);
});
