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
test.afterEach(() => sh(`rm -f ${IMAGES}/${NAME} ${IMAGES}/${RENAMED}`));

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
