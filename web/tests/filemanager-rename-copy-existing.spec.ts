import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// The File Manager's Rename and Copy buttons ask for a name with a prompt and
// post it (fpp.js RenameFile / CopyFile ->
// POST /api/file/<dir>/rename|copy/<source>/<dest>, files_rename / files_copy
// in www/api/controllers/files.php).  What happens when the name asked for is
// already another file's, is the file's own, or is not a name at all.  Each
// case reads both files back from the player.

test.skip(!container, 'seeds and reads scripts inside the run-web.sh container');

const DIR = `${MEDIA}/scripts`;
const A = 'fpp-tests-rc-a.sh';
const B = 'fpp-tests-rc-b.sh';
const C = 'fpp-tests-rc-c.sh';
const A_BODY = '#!/bin/sh\necho A\n';
const B_BODY = '#!/bin/sh\necho B, the one that must survive\n';

const clean = () => inPlayer('sh', '-c', `rm -f -- "${DIR}"/fpp-tests-rc-*`);
test.beforeEach(() => {
  clean();
  putFile(`${DIR}/${A}`, A_BODY);
  putFile(`${DIR}/${B}`, B_BODY);
});
test.afterEach(clean);

// The Scripts tab with A selected; `button` is clicked and the prompt answered.
async function press(page: Page, button: 'Rename' | 'Copy', answer: string) {
  const row = page.locator('#tblScripts tbody tr').filter({ has: page.locator('td', { hasText: new RegExp(`^${A.replace(/\./g, '\\.')}$`) }) });
  // Opened again if the listing did not make it into the table: the page's
  // start-up, which has its own spec (filemanager-opening-tab-table), is not
  // what is under test here.
  await expect(async () => {
    await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
    await page.waitForLoadState('load');
    await page.locator('#tab-scripts-tab').click();
    await expect(row).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 25_000 });
  await row.click();
  await expect(row).toHaveClass(/selectedEntry/);
  const asked = page.waitForResponse((r) => r.url().includes(`/${button.toLowerCase()}/`));
  page.once('dialog', (d) => d.accept(answer));
  await page.locator(`#tab-scripts input[value="${button}"]`).click();
  await asked;
}

const errorDialog = (page: Page) => page.locator('#dialogOKPopup');

test('the control: Rename and Copy to a name nothing has', async ({ page }) => {
  await press(page, 'Copy', C);
  await expect.poll(() => exists(`${DIR}/${C}`)).toBe(true);
  expect(readFile(`${DIR}/${C}`)).toBe(A_BODY);
  expect(readFile(`${DIR}/${A}`)).toBe(A_BODY);
  inPlayer('rm', '-f', `${DIR}/${C}`);

  await press(page, 'Rename', C);
  await expect.poll(() => exists(`${DIR}/${C}`)).toBe(true);
  expect(exists(`${DIR}/${A}`)).toBe(false);
  expect(readFile(`${DIR}/${B}`)).toBe(B_BODY);
  await expect(errorDialog(page)).toBeHidden();
});

test('Rename to another file\'s name does not replace that file', async ({ page }) => {
  test.fail(true, 'rename() over an existing file, no check and no question (FUTURE.md)');
  await press(page, 'Rename', B);
  expect(readFile(`${DIR}/${B}`), 'the other file was replaced').toBe(B_BODY);
  expect(exists(`${DIR}/${A}`), 'the file that was to be renamed').toBe(true);
  await expect(errorDialog(page)).toBeVisible();
});

test('Copy to another file\'s name does not replace that file', async ({ page }) => {
  test.fail(true, 'copy() over an existing file, no check and no question (FUTURE.md)');
  await press(page, 'Copy', B);
  expect(readFile(`${DIR}/${B}`), 'the other file was replaced').toBe(B_BODY);
  await expect(errorDialog(page)).toBeVisible();
});

test('Copy with the name left as offered is reported as failed and harms nothing', async ({ page }) => {
  // The prompt offers the file's own name: OK without typing copies a file
  // onto itself.
  await press(page, 'Copy', A);
  await expect(errorDialog(page)).toBeVisible();
  await expect(errorDialog(page).locator('.modal-title')).toHaveText('File Copy Failed');
  expect(readFile(`${DIR}/${A}`)).toBe(A_BODY);
  expect(readFile(`${DIR}/${B}`)).toBe(B_BODY);
});

test('a name with a path in it is refused by Rename and by Copy', async ({ page }) => {
  for (const [button, title] of [['Rename', 'File Rename Failed'], ['Copy', 'File Copy Failed']] as const) {
    await press(page, button, '..\\fpp-tests-rc-out.sh');
    await expect(errorDialog(page)).toBeVisible();
    await expect(errorDialog(page).locator('.modal-title')).toHaveText(title);
    expect(readFile(`${DIR}/${A}`), button).toBe(A_BODY);
    expect(inPlayer('sh', '-c', `ls -A "${MEDIA}" "${DIR}" | grep -c 'rc-out' || true`).trim(), button).toBe('0');
  }
});

test('the API names what it refused: no such directory, a bad name, a file that is not there', async ({ request }) => {
  for (const op of ['rename', 'copy']) {
    let r = await request.post(`/api/file/fpp-tests-nodir/${op}/${A}/${C}`);
    expect(await r.json(), op).toEqual({ status: 'Invalid Directory' });
    r = await request.post(`/api/file/scripts/${op}/${A}/x%5Cy.sh`);
    expect(await r.json(), op).toEqual({ status: 'Invalid filename' });
    r = await request.post(`/api/file/scripts/${op}/x%5Cy.sh/${C}`);
    expect(await r.json(), op).toEqual({ status: 'Invalid filename' });
    r = await request.post(`/api/file/scripts/${op}/fpp-tests-rc-none.sh/${C}`);
    expect(await r.json(), op).toEqual({ status: 'failure', original: 'fpp-tests-rc-none.sh', new: C });
    expect(exists(`${DIR}/${C}`), op).toBe(false);
  }
  expect(readFile(`${DIR}/${A}`)).toBe(A_BODY);
  expect(readFile(`${DIR}/${B}`)).toBe(B_BODY);
});
