import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// A File Manager tab whose directory holds nothing.

test.skip(!container, 'empties a media directory inside the run-web.sh container');

const DIR = '/home/fpp/media/effects';
const KEEP = '/tmp/fpp-tests-effects-kept';

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${KEEP} && mkdir -p ${KEEP} && find ${DIR} -mindepth 1 -maxdepth 1 -exec mv {} ${KEEP}/ \\;`);
});

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -rf ${DIR}/fpp-tests-effect.eseq; find ${KEEP} -mindepth 1 -maxdepth 1 -exec mv {} ${DIR}/ \\; ; rmdir ${KEEP}`);
});

test('an empty tab says "No files found." under its headings', async ({ page }) => {
  // Regression: bf63b30e6.  An empty directory's table was left with no
  // rows at all, which read as still loading.
  await page.goto('/filemanager.php#tab-effects');
  await page.locator('#tab-effects-tab').click();
  const table = page.locator('#tblEffects');
  await expect(table.locator('tbody')).toContainText('No files found.', { timeout: 15_000 });
  await expect(table.locator('thead th').first()).toContainText('File');
  // The control: once there is a file, the message goes.
  inPlayer('sh', '-c', `printf x > ${DIR}/fpp-tests-effect.eseq`);
  await page.goto('/filemanager.php?r=1#tab-effects');
  await page.locator('#tab-effects-tab').click();
  await expect(table.locator('tbody')).toContainText('fpp-tests-effect.eseq', { timeout: 15_000 });
  await expect(table.locator('tbody')).not.toContainText('No files found.');
});
