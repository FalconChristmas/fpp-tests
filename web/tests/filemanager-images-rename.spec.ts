import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// Regression: ee8bcf31d ("Add rename button to Images tab in File Manager").
// The Images tab had View, Download and Delete only, so an image uploaded
// under the wrong name could not be renamed there.  Rename is a single-file
// button: off until one image is selected.

test.skip(!container, 'seeds an image inside the run-web.sh container');

const IMAGES = '/home/fpp/media/images';
const NAME = 'fpp-tests-img.png';
const RENAMED = 'fpp-tests-img-renamed.png';
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const sh = (cmd: string) => inPlayer('sh', '-c', cmd);
const exists = (p: string) => sh(`test -e "${p}" && echo yes || echo no`).trim() === 'yes';

test.beforeEach(() => { sh(`mkdir -p ${IMAGES}`); putFile(`${IMAGES}/${NAME}`, PNG); sh(`chmod 666 ${IMAGES}/${NAME}`); });
test.afterEach(() => sh(`rm -f ${IMAGES}/${NAME} ${IMAGES}/${RENAMED} ${IMAGES}/null`));

async function imagesTab(page: Page) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-images`);
  await page.waitForLoadState('load');
  await page.locator('#tab-images-tab').click();
  return page.locator('#tab-images');
}

test('Rename on the Images tab is off with nothing selected and renames the selected image', async ({ page }) => {
  const pane = await imagesTab(page);
  const rename = pane.locator('input[value="Rename"]');
  const row = page.locator('#tblImages tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${NAME.replace('.', '\\.')}$`) }) });
  await expect(row).toBeVisible();
  await expect(rename).toBeDisabled();

  await row.click();
  await expect(row).toHaveClass(/selectedEntry/);
  await expect(rename).toBeEnabled();
  page.once('dialog', (d) => d.accept(RENAMED));
  await rename.click();
  await expect.poll(() => exists(`${IMAGES}/${RENAMED}`)).toBe(true);
  expect(exists(`${IMAGES}/${NAME}`), 'a rename moves the original').toBe(false);
});

test('cancelling the Rename prompt leaves the image alone', async ({ page }) => {
  // Regression: 04d541614 ("Don't rename files to "null" if cancel is
  // pressed").  prompt() answers null, which went into the rename URL.
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rename/')) asked.push(r.url()); });
  const pane = await imagesTab(page);
  const row = page.locator('#tblImages tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${NAME.replace('.', '\\.')}$`) }) });
  await row.click();
  page.once('dialog', (d) => d.dismiss());
  await pane.locator('input[value="Rename"]').click();
  // RenameFile posts straight after the prompt returns: give the post, if there
  // is one, time to be sent and carried out.
  await page.waitForTimeout(1000);
  expect(asked, 'no rename was asked for').toEqual([]);
  expect(exists(`${IMAGES}/${NAME}`), 'the image keeps its name').toBe(true);
  expect(exists(`${IMAGES}/null`), 'no image called null').toBe(false);
});

test('Rename is off with nothing selected when the image listing arrives before the page has set up', async ({ page }) => {
  // Regression: f824f1fbb.  The selection buttons are written with only the
  // disableButtons class; the disabled state came only from a table redraw
  // or a row click, through a handler bound as the page finishes setting up.
  // A listing that came back first (a slow board, a busy browser) rendered
  // its table before that handler was there, so Rename looked off but still
  // worked with nothing selected.  Here the page's set-up (jQuery's ready)
  // is held until the Images listing has rendered.
  await page.addInitScript(() => {
    let jq: any;
    let held = false;
    Object.defineProperty(window, 'jQuery', {
      configurable: true,
      get: () => jq,
      set: (v) => { jq = v; if (!held && v && v.holdReady) { held = true; v.holdReady(true); } },
    });
  });
  // Answered once the document has loaded, so it renders at once.
  await page.route('**/api/files/Images*', async (r) => {
    await page.waitForFunction(() => document.readyState !== 'loading');
    await r.continue();
  });
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-images`);
  const row = page.locator('#tblImages tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${NAME.replace('.', '\\.')}$`) }) });
  await expect(row).toHaveCount(1);
  await page.evaluate(() => (window as any).jQuery.holdReady(false));
  await page.waitForLoadState('load');
  await page.locator('#tab-images-tab').click();
  await expect(row).toBeVisible();
  await expect(page.locator('#tab-images input[value="Rename"]')).toBeDisabled();
});
