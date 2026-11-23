import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

// First use on a fresh page: the first thing a user does after the page loads
// opens the dialog, with nothing else on the page opened before it.
//
// The Command Editor is a fragment (commandEditor.php) that ShowCommandEditor
// .load()s into a singleton dialog on first use; its script declares the
// globals (commandEditorTarget, CommandEditorSetup, CommandEditorSave, ...)
// the rest of the page leans on.  #3209 (fix 155bad634): an If's "+ Add
// Command" in the Playlist Editor read those globals before any editor had
// loaded them and threw a ReferenceError.  Specs that opened another editor
// first had them in place, and hid it.  So each test here goes to its page
// and opens the editor the way a new item does, as the first action, then
// saves and reads back what the player stored.
//
// Already first-use elsewhere, so not repeated here: Run FPP Command on
// index.php (command-run-now, run-command-dialog), an existing row's Edit on
// Command Presets, Scheduler, Recurring Tasks and GPIO (command-args-hosts),
// the Playlist Editor's New/Edit Entry and an inline If's Add Command
// (playlist-entry-editor, playlist-entry-if-command-list), the playlist
// Choose File dialog (playlist-file-chooser), the holiday editor
// (scheduler-page-entries), the schedule previews (schedule-preview-*,
// schedule-calendar-view), Settings F1 help (page-help) and the File
// Manager's dialogs (filemanager-* specs).

const NAME = 'fpp-tests-fresh-page';
// A command with one plain argument, harmless if it ever ran; every item
// saved here is disabled all the same.
const CMD = 'Volume Decrease';

const editor = (page: Page) => page.locator('#commandEditorPopup');

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

// Once the dialog has faded in: Bootstrap drops a hide asked for during the
// fade, so a Save clicked then would leave it open.
const settled = (modal: Locator) => modal.evaluate((el) => new Promise<void>((resolve) => {
  const m = (window as any).bootstrap.Modal.getInstance(el);
  if (!m || !m._isTransitioning) resolve();
  else el.addEventListener('shown.bs.modal', () => resolve(), { once: true });
}));

// The editor the row's command select opened, its argument set, and accepted.
async function editAndAccept(page: Page, value: string) {
  const dialog = editor(page);
  await expect(dialog.locator('#editorCommand')).toHaveValue(CMD, { timeout: 15_000 });
  await settled(dialog);
  await dialog.locator('#tblCommandEditor_arg_1').fill(value);
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect(dialog).toBeHidden();
}

test.describe('a new row whose command is picked from its list opens the Command Editor, and saves what it was given', () => {
  test('on Command Presets', async ({ page, request }) => {
    const PRESETS = 'api/configfile/commandPresets.json';
    const before = await keep(request, PRESETS);
    try {
      await page.goto('/commandPresets.php');
      const rows = page.locator('#tblCommandsBody > tr');
      const n = await rows.count();
      await page.locator('button[onclick="AddCommand();"]:visible').first().click();
      await expect(rows).toHaveCount(n + 1);
      const row = rows.nth(n);
      await row.locator('.cmdTmplName').fill(NAME);
      // Picking the command is what opens the editor (the select's onChange).
      await row.locator('select.cmdTmplCommand').selectOption(CMD);
      await editAndAccept(page, '7');

      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('commandPresets.json'));
      await page.locator('button[value=Save]:visible').first().click();
      expect((await posted).ok()).toBe(true);
      const saved = ((await (await request.get(PRESETS)).json()).commands as any[]).find((c) => c.name === NAME);
      expect(saved).toMatchObject({ command: CMD, args: ['7'] });
    } finally {
      await put(request, PRESETS, before ?? '{}');
    }
  });

  test('on the Scheduler', async ({ page, request }) => {
    const before = await (await request.get('/api/schedule')).json();
    try {
      await page.goto('/scheduler.php');
      const rows = page.locator('#tblScheduleBody > tr');
      // getSchedule() has drawn the stored rows.
      await expect(rows).toHaveCount(before.length, { timeout: 15_000 });
      await page.locator('[onclick="AddScheduleEntry();"]:visible').first().click();
      await expect(rows).toHaveCount(before.length + 1);
      const row = rows.nth(before.length);
      await row.locator('.schEnable').uncheck();
      await row.locator('.schType').selectOption('command');
      await row.locator('select.cmdTmplCommand').selectOption(CMD);
      await editAndAccept(page, '7');

      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
      await page.locator('input[value="Save"]:visible').first().click();
      expect((await posted).ok()).toBe(true);
      const schedule = await (await request.get('/api/schedule')).json();
      expect(schedule).toHaveLength(before.length + 1);
      // The stored entry has no type of its own: one with a command is a command entry.
      expect(schedule[before.length]).toMatchObject({ enabled: 0, playlist: '', command: CMD, args: ['7'] });
    } finally {
      await request.post('/api/schedule', { data: before });
      await request.post('/api/schedule/reload');
    }
  });

  test('on Recurring Tasks, with the task\'s Result Variable section', async ({ page, request }) => {
    const TASKS = 'api/configfile/recurringtasks.json';
    const before = await keep(request, TASKS);
    try {
      await page.goto('/recurringtasks.php');
      const rows = page.locator('#tblTasksBody > tr');
      const n = (JSON.parse(before ?? '[]') as unknown[]).length;
      await expect(rows).toHaveCount(n, { timeout: 15_000 });
      await page.locator('button', { hasText: /Add$/ }).click();
      await expect(rows).toHaveCount(n + 1);
      const row = rows.nth(n);
      await row.locator('.ptTmplEnabled').uncheck();
      await row.locator('.ptTmplName').fill(NAME);
      await row.locator('.ptTmplType').selectOption('command');
      await row.locator('select.cmdTmplCommand').selectOption(CMD);
      // The task's own fields are added to the same dialog once it has loaded.
      await expect(editor(page)).toContainText('Result Variable / Filter', { timeout: 15_000 });
      await editor(page).locator('.ptTmplResultVariable').fill('fppTestsFreshPage');
      await editAndAccept(page, '7');

      await page.locator('button', { hasText: /^Save$/ }).click();
      await expect(page.locator('#jGrowl')).toContainText('Recurring tasks saved and reloaded.');
      const saved = (JSON.parse((await keep(request, TASKS)) ?? '[]') as any[]).find((t) => t.name === NAME);
      expect(saved).toMatchObject({ enabled: false, type: 'command', command: CMD, args: ['7'], resultVariable: 'fppTestsFreshPage' });
    } finally {
      await put(request, TASKS, before ?? '[]');
      await request.post('api/fppd/recurringtasks', { data: { command: 'reload' } });
    }
  });
});

test.describe('a saved If entry in the Playlist Editor', () => {
  // The inline Then Run list's Edit takes the same path as its Add Command
  // (#3209), for a row already there: the entry dialog is the only one that
  // has opened, and no Command Editor has loaded.
  const TRUE = JSON.stringify({ op: 'AND', conditions: [{ source: 'Expression', name: '1', comparator: 'equal to', value: '1' }] });
  const then = (v: string) => JSON.stringify([{ command: CMD, args: [v], multisyncCommand: false, multisyncHosts: '' }]);
  let uiLevel = '0';

  test.beforeEach(async ({ request }) => {
    // If is an Advanced command.
    uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
    await request.put('/api/settings/uiLevel', { data: '1' });
    const r = await request.post(`/api/playlist/${NAME}`, { data: {
      name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], leadOut: [], playlistInfo: {},
      mainPlaylist: [{ type: 'command', enabled: 1, playOnce: 0, command: 'If', multisyncCommand: false, multisyncHosts: '',
        args: [TRUE, then('7'), 'Sequential', '[]', 'Sequential'] }],
    } });
    expect(r.ok(), await r.text()).toBe(true);
  });
  test.afterEach(async ({ request }) => {
    await request.delete(`/api/playlist/${NAME}`);
    await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  });

  test('has its Then Run command edited from the Edit Entry dialog, and saves the edit', async ({ page, request }) => {
    await page.goto('/playlists.php');
    await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
    await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
    await page.locator('.playlistRowEditButton').first().click();
    const entry = page.locator('.modal.show').filter({ has: page.locator('#pe_type') });
    await expect(entry.locator('.modal-title')).toHaveText('Edit Entry');
    await settled(entry);
    const list = entry.locator('#playlistEntryCommandOptions_arg_2_container');
    await expect(list.locator('.cmdListLabel')).toHaveText([`${CMD}: 7`]);

    await list.locator('.cmdListRow button[title=Edit]').click();
    const dialog = editor(page);
    await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Save Command', { timeout: 15_000 });
    await expect(dialog.locator('#editorCommand')).toHaveValue(CMD);
    await expect(dialog.locator('#tblCommandEditor_arg_1')).toHaveValue('7');
    await settled(dialog);
    await dialog.locator('#tblCommandEditor_arg_1').fill('9');
    await dialog.locator('#btnSaveEditorCommand').click();
    await expect(dialog).toBeHidden();
    await expect(list.locator('.cmdListLabel')).toHaveText([`${CMD}: 9`]);

    await entry.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(entry).toBeHidden();
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
    await page.getByRole('button', { name: 'Save Playlist' }).click();
    expect((await saved).ok()).toBe(true);
    const args = (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0].args;
    expect(JSON.parse(args[1]).map((c: any) => ({ command: c.command, args: c.args }))).toEqual([{ command: CMD, args: ['9'] }]);
    expect(JSON.parse(args[3])).toEqual([]);
  });
});
