import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { answerUpdateCheck } from './standin-http';

// The File Manager's editors: Edit in the Scripts tab (api/scripts/<name>),
// and, at the Developer UI level, Edit and Delete in the Config tab
// (api/file/Config/<name>).  What is opened, saved, kept on Cancel, and what
// a save that fails says.

test.skip(!container, 'seeds scripts and config files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SCRIPTS = `${MEDIA}/scripts`;
const CONFIG = `${MEDIA}/config`;
const P = 'fpp-tests-edit';

const sh = (script: string) => inPlayer('sh', '-c', script);
const b64 = (s: string) => Buffer.from(s).toString('base64');
const put = (path: string, text: string) => sh(`printf '%s' '${b64(text)}' | base64 -d > '${path}'`);
const read = (path: string) => Buffer.from(sh(`base64 -w0 '${path}' 2>/dev/null || true`).trim(), 'base64').toString();
const exists = (path: string) => sh(`test -e '${path}' && echo yes || echo no`).trim() === 'yes';

let uiLevel = '0';
test.beforeEach(async ({ page, request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  await answerUpdateCheck(page);
});
test.afterEach(async ({ request }) => {
  sh(`rm -f ${SCRIPTS}/${P}-* ${CONFIG}/${P}-*`);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

function row(page: Page, table: string, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.locator(`#tbl${table} tbody tr`).filter({ has: page.locator('td', { hasText: new RegExp(`^${esc}$`) }) });
}

async function openTab(page: Page, tab: 'scripts' | 'config', table: string, name: string) {
  await page.goto(`/filemanager.php?fpp-tests=${Date.now()}`);
  await page.locator(`#tab-${tab}-tab`).click();
  await row(page, table, name).click();
}

async function setLevel(request: APIRequestContext, level: string) {
  expect((await request.put('/api/settings/uiLevel', { data: level })).ok()).toBe(true);
}

test.describe('the script editor', () => {
  const name = `${P}-show.sh`;
  const original = '#!/bin/sh\necho "lights on"\n';

  test.beforeEach(() => put(`${SCRIPTS}/${name}`, original));

  test('opens the script, saves what was typed, and Cancel keeps it as it was', async ({ page }) => {
    await openTab(page, 'scripts', 'Scripts', name);
    await page.locator('#tab-scripts input[value="Edit"]').click();
    const dialog = page.locator('#scriptEditorDialog');
    await expect(dialog.locator('.modal-title')).toHaveText(`Script Editor : ${name}`);
    const text = dialog.locator('#scriptText');
    await expect(text).toHaveValue(original);

    // Cancel: nothing is written.
    await text.fill('#!/bin/sh\necho "not this"\n');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(read(`${SCRIPTS}/${name}`)).toBe(original);

    // Save: what was typed is the script, and the dialog closes with a toast.
    await page.locator('#tab-scripts input[value="Edit"]').click();
    await expect(text).toHaveValue(original);
    const edited = '#!/bin/sh\necho "lights on"\necho "and the music"\n';
    await text.fill(edited);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#jGrowl')).toContainText('Script saved.');
    expect(read(`${SCRIPTS}/${name}`)).toBe(edited);
  });

  test('a script deleted while it was open is not saved, and the dialog says why', async ({ page }) => {
    await openTab(page, 'scripts', 'Scripts', name);
    await page.locator('#tab-scripts input[value="Edit"]').click();
    const dialog = page.locator('#scriptEditorDialog');
    await expect(dialog.locator('#scriptText')).toHaveValue(original);
    sh(`rm -f ${SCRIPTS}/${name}`);
    await dialog.locator('#scriptText').fill('echo late\n');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Save Failed: Error, file does not exist')).toBeVisible();
    expect(exists(`${SCRIPTS}/${name}`), 'the save does not make the file again').toBe(false);
  });

  test('a script with HTML-like text in it is shown and saved as it is', async ({ page }) => {
    // Shell scripts are full of &, < and >; one that echoes HTML may hold
    // entities and tags, even a closing textarea tag.
    //
    // Known bug (~/FUTURE.md, fpp 49f2b29a0): EditScript() builds the
    // textarea as HTML with the script's text inside it, so the browser
    // decodes the entities, a </textarea> ends the box early and what follows
    // becomes part of the page, and Save writes back what is left.  The
    // config editor sets the text with .val() and keeps it whole.  This test
    // passes as an expected failure until that is fixed; then drop the mark.
    test.fail();
    const tricky = '#!/bin/sh\n[ -f a ] && echo "a &amp; b &lt;c&gt; <b>bold</b>" > /tmp/x\n' +
      'echo "</textarea><i>after</i>"\necho done\n';
    put(`${SCRIPTS}/${name}`, tricky);
    await openTab(page, 'scripts', 'Scripts', name);
    await page.locator('#tab-scripts input[value="Edit"]').click();
    const dialog = page.locator('#scriptEditorDialog');
    await expect(dialog.locator('#scriptText')).toHaveValue(tricky);
    // Nothing of the script is made into the page's own elements.
    await expect(dialog.locator('.modal-body i')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    expect(read(`${SCRIPTS}/${name}`), 'saving unchanged leaves the script unchanged').toBe(tricky);
  });
});

test.describe('the config editor (Developer level)', () => {
  const name = `${P}-cfg.json`;
  const original = '{\n  "a": "x & y </textarea> <b>z</b>"\n}\n';

  test.beforeEach(async ({ request }) => {
    await setLevel(request, '3');
    put(`${CONFIG}/${name}`, original);
  });

  test('opens a config file as it is, saves an edit, and Cancel writes nothing', async ({ page }) => {
    await openTab(page, 'config', 'Config', name);
    await page.locator('#tab-config input[value="Edit"]').click();
    const dialog = page.locator('#configEditorDialog');
    await expect(dialog.locator('.modal-title')).toHaveText(`Config Editor : ${name}`);
    const text = dialog.locator('#configText');
    await expect(text).toHaveValue(original);

    await text.fill('{"cancelled": true}\n');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(read(`${CONFIG}/${name}`)).toBe(original);

    await page.locator('#tab-config input[value="Edit"]').click();
    await expect(text).toHaveValue(original);
    const edited = '{\n  "a": "x & y </textarea> <b>z</b>",\n  "b": 2\n}\n';
    await text.fill(edited);
    // The listing is read again after the save.
    const relisted = page.waitForRequest((r) => /\/api\/files\/Config\?.*maxdepth=1/i.test(r.url()));
    await dialog.locator('#configEditorSaveButton').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#jGrowl')).toContainText('Config file saved.');
    await relisted;
    expect(read(`${CONFIG}/${name}`)).toBe(edited);
  });

  test('a config file that cannot be read says so in the editor', async ({ page }) => {
    await openTab(page, 'config', 'Config', name);
    sh(`rm -f ${CONFIG}/${name}`);
    await page.locator('#tab-config input[value="Edit"]').click();
    await expect(page.locator('#configEditorDialog #fileEditText')).toHaveText('Error loading file.');
  });

  test('Delete asks first, names the files, and deletes them only on yes', async ({ page }) => {
    const second = `${P}-cfg2.json`;
    put(`${CONFIG}/${second}`, '{}\n');
    await openTab(page, 'config', 'Config', name);
    await row(page, 'Config', second).click({ modifiers: ['ControlOrMeta'] });

    await page.locator('#tab-config input[value="Delete"]').click();
    const confirm = page.locator('#confirmDeleteConfig');
    await expect(confirm.locator('.modal-title')).toHaveText('Delete Configuration Files');
    await expect(confirm).toContainText('This cannot be undone and may break your system.');
    await expect(confirm.locator('li')).toHaveText([name, second]);
    await confirm.getByRole('button', { name: /^(No|Cancel)$/ }).click();
    await expect(confirm).toBeHidden();
    expect(exists(`${CONFIG}/${name}`) && exists(`${CONFIG}/${second}`)).toBe(true);

    await page.locator('#tab-config input[value="Delete"]').click();
    await confirm.getByRole('button', { name: /^(Yes|Delete|OK)$/ }).click();
    await expect(row(page, 'Config', name)).toHaveCount(0);
    await expect(row(page, 'Config', second)).toHaveCount(0);
    await expect.poll(() => exists(`${CONFIG}/${name}`) || exists(`${CONFIG}/${second}`)).toBe(false);
  });
});
