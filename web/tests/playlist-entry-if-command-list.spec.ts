import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

// An If command as a Playlist Editor entry: its Then Run and Otherwise Run
// lists are drawn inline in the entry dialog, and "+ Add Command" opens the
// command editor over it to pick each command.
//
// Regression: 155bad634.  The list's Add Command assumed it was inside the
// command editor dialog: it saved that dialog's state to reopen it after the
// pick, using globals commandEditor.php declares.  In the Playlist Editor,
// before any command editor had opened, that threw "commandEditorTarget is
// not defined" and nothing opened.  The list now redraws in place when it is
// not inside the command editor.

const NAME = 'fpp-tests-entry-if';

async function storePlaylist(request: APIRequestContext, mainPlaylist: object[]) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist, leadOut: [], playlistInfo: {} },
  });
  expect(r.ok(), `storing ${NAME}: ${r.status()}`).toBe(true);
}

async function storedPlaylist(request: APIRequestContext) {
  return (await request.get(`/api/playlist/${NAME}`)).json();
}

async function openEditor(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function savePlaylist(page: Page) {
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
}

// As playlist-entry-args.spec.ts: wait for the show transition to end, or a
// hide asked for while it is still fading in is dropped.
async function openNewEntry(page: Page) {
  await page.evaluate(() => {
    (window as any).fppTestsModalShown = false;
    document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
  });
  await page.locator('.playlistEntriesAddNewBtn').first().click();
  await page.waitForFunction(() => (window as any).fppTestsModalShown);
}

async function addEntry(page: Page, entry: Locator) {
  const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
  const before = await rows.count();
  await entry.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rows).toHaveCount(before + 1);
}

// A New Entry dialog set to FPP Command / If.
async function newIfEntry(page: Page) {
  await openNewEntry(page);
  const entry = page.locator('.modal.show').filter({ has: page.locator('#pe_type') });
  await page.selectOption('#pe_type', 'command');
  await page.selectOption('#playlistEntryOptions_arg_1', 'If');
  await expect(entry.locator('#playlistEntryCommandOptions input[value="+ Add Command"]')).toHaveCount(2);
  return entry;
}

const picker = (page: Page) => page.locator('#commandEditorPopup');

// The picker is the dialog on top: what is under the middle of its content
// is part of it, not the entry dialog it opened over.
async function expectOnTop(page: Page) {
  const content = picker(page).locator('.modal-content');
  await expect(content).toBeVisible();
  const box = (await content.boundingBox())!;
  const inside = await page.evaluate(([x, y]) =>
    !!document.elementFromPoint(x, y)?.closest('#commandEditorPopup'), [box.x + box.width / 2, box.y + 20]);
  expect(inside, 'the picker is on top of the entry dialog').toBe(true);
}

// Picks Set Variable for a list and adds it.
async function pickSetVariable(page: Page, name: string, value: string) {
  const dialog = picker(page);
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
  await expectOnTop(page);
  await dialog.locator('#editorCommand').selectOption('Set Variable');
  await dialog.locator('#tblCommandEditor_arg_1').fill(name);
  await dialog.locator('#tblCommandEditor_arg_3').fill(value);
  await dialog.locator('#btnSaveEditorCommand').click();
}

const setVariable = (name: string, value: string) => ({ command: 'Set Variable', args: [name, 'Value', value, '1', '0', '100', '', 'false'] });
const summary = (name: string, value: string) => `Set Variable: ${name}, Value, ${value}, 1, 0, 100, —, false`;
const commandsOf = (json: string) => JSON.parse(json).map((c: any) => ({ command: c.command, args: c.args }));

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  // If is an Advanced command.
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  await request.put('/api/settings/uiLevel', { data: '1' });
  await storePlaylist(request, []);
});
test.afterEach(async ({ request }) => {
  await request.delete(`/api/playlist/${NAME}`);
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

test('an If entry\'s Then Run and Otherwise Run lists take commands from Add Command, and save them', async ({ page, request }) => {
  const errors = pageErrors(page);
  await openEditor(page);
  const entry = await newIfEntry(page);
  const add = entry.locator('#playlistEntryCommandOptions input[value="+ Add Command"]');

  await add.nth(0).click();
  await pickSetVariable(page, 'fppTestsThen', 'yes');
  await expect(picker(page)).toBeHidden();
  await expect(entry.locator('#playlistEntryCommandOptions_arg_2_container .cmdListLabel')).toHaveText(summary('fppTestsThen', 'yes'));

  await add.nth(1).click();
  await pickSetVariable(page, 'fppTestsElse', 'no');
  await expect(picker(page)).toBeHidden();
  await expect(entry.locator('#playlistEntryCommandOptions_arg_4_container .cmdListLabel')).toHaveText(summary('fppTestsElse', 'no'));
  expect(errors).toEqual([]);

  await addEntry(page, entry);
  await savePlaylist(page);
  const args = (await storedPlaylist(request)).mainPlaylist[0].args;
  expect(commandsOf(args[1])).toEqual([setVariable('fppTestsThen', 'yes')]);
  expect(commandsOf(args[3])).toEqual([setVariable('fppTestsElse', 'no')]);
  expect(errors).toEqual([]);
});

test('an If picked into an If entry\'s list takes its own commands, and the picker comes back as it was', async ({ page, request }) => {
  // The nested If's list is inside the picker, so its Add Command reopens
  // the picker after its pick, with the picker's own Add Command button
  // (it came back as the Run FPP Command editor's "Accept Changes").
  const errors = pageErrors(page);
  await openEditor(page);
  const entry = await newIfEntry(page);
  await entry.locator('#playlistEntryCommandOptions input[value="+ Add Command"]').first().click();

  const dialog = picker(page);
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
  await dialog.locator('#editorCommand').selectOption('If');
  await dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first().click();
  await pickSetVariable(page, 'fppTestsNested', 'deep');

  await expect(dialog.locator('#editorCommand')).toHaveValue('If', { timeout: 15_000 });
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command');
  await expect(dialog.locator('.cmdListLabel')).toHaveText(summary('fppTestsNested', 'deep'));
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect(dialog).toBeHidden();
  await expect(entry.locator('#playlistEntryCommandOptions_arg_2_container .cmdListLabel')).toHaveText(/^If: .*fppTestsNested/);
  expect(errors).toEqual([]);

  await addEntry(page, entry);
  await savePlaylist(page);
  const then = JSON.parse((await storedPlaylist(request)).mainPlaylist[0].args[1]);
  expect(then.map((c: any) => c.command)).toEqual(['If']);
  expect(commandsOf(then[0].args[1])).toEqual([setVariable('fppTestsNested', 'deep')]);
  expect(errors).toEqual([]);
});

// Picks a command with no arguments into the list whose Add Command was
// clicked, after optionally browsing the picker through another command.
async function pickPlain(page: Page, command: string, browseFirst?: string) {
  const dialog = picker(page);
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
  if (browseFirst) {
    await dialog.locator('#editorCommand').selectOption(browseFirst);
    await expect(dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first()).toBeVisible();
  }
  await dialog.locator('#editorCommand').selectOption(command);
  await dialog.locator('#btnSaveEditorCommand').click();
}

// An If picked into the entry's list, with Stop Now already in its Then list:
// the picker, back as that If.
async function nestedIfWithStopNow(page: Page) {
  await openEditor(page);
  const entry = await newIfEntry(page);
  await entry.locator('#playlistEntryCommandOptions input[value="+ Add Command"]').first().click();
  const dialog = picker(page);
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
  await dialog.locator('#editorCommand').selectOption('If');
  await dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first().click();
  await pickPlain(page, 'Stop Now');
  await expect(dialog.locator('#editorCommand')).toHaveValue('If', { timeout: 15_000 });
  await expect(dialog.locator('#tblCommandEditor_arg_2_container .cmdListLabel')).toHaveText(['Stop Now']);
  return dialog;
}

test('a second pick into a nested If\'s list keeps the first', async ({ page }) => {
  // The control for the test below: the same picks, without browsing the
  // second picker through If.
  const dialog = await nestedIfWithStopNow(page);
  await dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first().click();
  await pickPlain(page, 'Stop Gracefully');
  await expect(dialog.locator('#editorCommand')).toHaveValue('If', { timeout: 15_000 });
  await expect(dialog.locator('#tblCommandEditor_arg_2_container .cmdListLabel')).toHaveText(['Stop Now', /^Stop Gracefully/]);
});

test('a second pick into a nested If\'s list keeps the first, even when the picker was set to If on the way', async ({ page }) => {
  // FPP bug (~/FUTURE.md "#3209 follow-ups", "a nested If wipes the outer
  // list's earlier rows"): every command editor uses tblCommandEditor_arg_N
  // ids, so the second picker drawing an If (even only browsing to it) resets
  // commandListState['tblCommandEditor_arg_2'], the nested If's own list, and
  // the pick then lands in the emptied list: Stop Now is gone.
  test.fail(true, 'browsing the picker to If empties the nested If\'s list (FPP bug)');
  const dialog = await nestedIfWithStopNow(page);
  await dialog.locator('#tblCommandEditor input[value="+ Add Command"]').first().click();
  await pickPlain(page, 'Stop Gracefully', 'If');
  await expect(dialog.locator('#editorCommand')).toHaveValue('If', { timeout: 15_000 });
  await expect(dialog.locator('#tblCommandEditor_arg_2_container .cmdListLabel')).toHaveText(['Stop Now', /^Stop Gracefully/], { timeout: 5_000 });
});
