import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Uploaded Files tab of the File Manager: Copy and Rename act on the
// selected file, with the receiving end (the media directory) checked.

test.skip(!container, 'seeds files inside the run-web.sh container');

const UPLOAD = '/home/fpp/media/upload';
const NAME = 'fpp-tests-upl.txt';

const sh = (cmd: string) => inPlayer('sh', '-c', cmd);
const exists = (p: string) => sh(`test -e "${p}" && echo yes || echo no`).trim() === 'yes';

test.beforeEach(() => sh(`mkdir -p ${UPLOAD} && echo x > ${UPLOAD}/${NAME}`));
test.afterEach(() => sh(`rm -f ${UPLOAD}/${NAME} ${UPLOAD}/fpp-tests-upl-copy.txt ${UPLOAD}/fpp-tests-upl-renamed.txt`));

async function selectUpload(page: Page) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}#tab-uploads`);
  await page.waitForLoadState('load');
  await page.locator('#tab-uploads-tab').click();
  const row = page.locator('#tblUploads tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${NAME}$`) }) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveClass(/selectedEntry/);
}

test('Copy and Rename on the Uploaded Files tab copy and rename the selected file', async ({ page }) => {
  // Regression: 26f08ec9c.  The tab had Download and Delete only; a file
  // uploaded under the wrong name could not be copied or renamed there.
  await selectUpload(page);
  const pane = page.locator('#tab-uploads');
  await expect(pane.locator('input[value="Copy"]')).toBeEnabled();
  await expect(pane.locator('input[value="Rename"]')).toBeEnabled();

  page.once('dialog', (d) => d.accept('fpp-tests-upl-copy.txt'));
  await pane.locator('input[value="Copy"]').click();
  await expect.poll(() => exists(`${UPLOAD}/fpp-tests-upl-copy.txt`)).toBe(true);
  expect(exists(`${UPLOAD}/${NAME}`), 'a copy leaves the original').toBe(true);

  await selectUpload(page);
  page.once('dialog', (d) => d.accept('fpp-tests-upl-renamed.txt'));
  await pane.locator('input[value="Rename"]').click();
  await expect.poll(() => exists(`${UPLOAD}/fpp-tests-upl-renamed.txt`)).toBe(true);
  expect(exists(`${UPLOAD}/${NAME}`), 'a rename moves the original').toBe(false);
});
