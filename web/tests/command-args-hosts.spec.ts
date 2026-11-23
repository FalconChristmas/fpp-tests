import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { container } from './container';
import { snapshotSettings } from './settings-file';

// fpp.js's PrintArgInputs draws a command's arguments the same way on every
// page that edits a command, but the special argument types run their own
// script there: an If's Check (conditionlist) and Then Run list
// (commandlist), Set Variable's Expression, and Test Start's Test Pattern
// (subcommand).  #3209 (fix 155bad634): an If's "+ Add Command" threw in the
// Playlist Editor, which draws the arguments inline, from 10.0 to 10.4, while
// the Run FPP Command dialog, the only place it was tested, was fine.  So each
// type is driven here on each page that hosts the editor: edited, saved,
// opened again from what was saved, and the saved arguments checked for what
// fppd reads.  The Run FPP Command dialog has its own tests of each type
// (command-editor, condition-editor and command-editor-subcommand specs), and
// an inline If's command list its own #3209 spec.

const NAME = 'fpp-tests-argshosts';
const VAR = 'fppTestsArgsHosts';

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

// Where a command's arguments are drawn: the table PrintArgInputs is given,
// whose id prefixes each argument's (`<tbl>_arg_<n>`).
type Args = { scope: Locator; tbl: string };
type Saved = { command: string; args: string[] };

// Once a dialog has faded in: closed during the fade, an fppDialog stays open.
const settled = (modal: Locator) => modal.evaluate((el) => new Promise<void>((resolve) => {
  const m = (window as any).bootstrap.Modal.getInstance(el);
  if (!m || !m._isTransitioning) resolve();
  else el.addEventListener('shown.bs.modal', () => resolve(), { once: true });
}));

// ---------------------------------------------------------------------------
// The types: a command with an argument of the type, an edit of it, what the
// saved arguments must then be, and what the reopened editor must show.

type ArgType = {
  command: string;
  edit(page: Page, a: Args): Promise<void>;
  saved(args: string[]): void;
  reopened(page: Page, a: Args): Promise<void>;
};

const COND = { source: 'Expression', name: VAR, comparator: 'greater than', value: '3' };
const CMD = { command: 'Volume Decrease', args: ['7'] };
const EXPR = '=2+3*4';

const TYPES: Record<string, ArgType> = {
  conditionlist: {
    command: 'If',
    async edit(page, a) {
      // A new If starts with one blank condition; it is edited in its own
      // dialog, over the editor.
      const row = a.scope.locator('.condListRow');
      await expect(row).toHaveCount(1);
      await row.locator('button[title=Edit]').click();
      const editor = page.locator('.modal:has(.modal-title:text-is("Edit Condition"))').last();
      await expect(editor).toBeVisible();
      await settled(editor);
      const field = (label: string) =>
        editor.locator('span.text-muted.text-center', { hasText: new RegExp(`^${label}`) }).locator('xpath=..');
      await field('Name').locator('textarea').fill(VAR);
      await field('Is').locator('select').selectOption(COND.comparator);
      await field('Value').locator('textarea').fill(COND.value);
      await editor.locator('input[value=Close]').click();
      await expect(editor).toBeHidden();
      await expect(row).toHaveText(`Expression ${VAR} greater than "3"`);
    },
    saved(args) {
      // fppd's ConditionNode reads a group of conditions.
      expect(JSON.parse(args[0])).toEqual({ op: 'AND', conditions: [COND] });
    },
    async reopened(page, a) {
      await expect(a.scope.locator('.condListRow')).toHaveText([`Expression ${VAR} greater than "3"`]);
    },
  },
  commandlist: {
    command: 'If',
    async edit(page, a) {
      // Then Run's Add Command opens a picker in the Command Editor dialog.
      await a.scope.locator('input[value="+ Add Command"]').first().click();
      const picker = page.locator('#commandEditorPopup');
      await expect(picker.locator('#btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
      await picker.locator('#editorCommand').selectOption(CMD.command);
      await picker.locator('#tblCommandEditor_arg_1').fill(CMD.args[0]);
      await picker.locator('#btnSaveEditorCommand').click();
      await expect(a.scope.locator('.cmdListLabel')).toHaveText([`${CMD.command}: ${CMD.args[0]}`], { timeout: 15_000 });
    },
    saved(args) {
      // fppd's If reads Then Run as a JSON list of {command, args}.
      expect(JSON.parse(args[1]).map((c: any) => ({ command: c.command, args: c.args }))).toEqual([CMD]);
      expect(JSON.parse(args[3])).toEqual([]);
    },
    async reopened(page, a) {
      await expect(a.scope.locator('.cmdListLabel')).toHaveText([`${CMD.command}: ${CMD.args[0]}`]);
    },
  },
  expression: {
    command: 'Set Variable',
    async edit(page, a) {
      await a.scope.locator(`#${a.tbl}_arg_1`).fill(VAR);
      await a.scope.locator(`#${a.tbl}_arg_2`).selectOption('Expression');
      const expr = a.scope.locator('.arg_expression');
      await expect(expr).toBeVisible();
      await expr.fill(EXPR);
      await expect(a.scope.locator('.expressionValidIcon i')).toHaveClass(/fa-check/);
    },
    saved(args) {
      expect(args.slice(0, 2)).toEqual([VAR, 'Expression']);
      expect(args[6]).toBe(EXPR);
    },
    async reopened(page, a) {
      await expect(a.scope.locator(`#${a.tbl}_arg_2`)).toHaveValue('Expression');
      await expect(a.scope.locator('.arg_expression')).toBeVisible();
      await expect(a.scope.locator('.arg_expression')).toHaveValue(EXPR);
    },
  },
  subcommand: {
    command: 'Test Start',
    async edit(page, a) {
      // The pattern's own arguments (Channel Range, Color Pattern) follow it.
      await a.scope.locator(`#${a.tbl}_arg_2`).selectOption('RGB Cycle');
      await expect(a.scope.locator(`#${a.tbl}_arg_4`)).toBeVisible();
      await a.scope.locator(`#${a.tbl}_arg_3`).fill('1-150');
      await a.scope.locator(`#${a.tbl}_arg_4`).selectOption('R-G-B');
    },
    saved(args) {
      expect(args).toEqual(['1000', 'RGB Cycle', '1-150', 'R-G-B']);
    },
    async reopened(page, a) {
      await expect(a.scope.locator(`#${a.tbl}_arg_2`)).toHaveValue('RGB Cycle');
      await expect(a.scope.locator(`#${a.tbl}_arg_3`)).toHaveValue('1-150');
      await expect(a.scope.locator(`#${a.tbl}_arg_4`)).toHaveValue('R-G-B');
    },
  },
};

// ---------------------------------------------------------------------------
// The hosts: put a new item running `command` on the page and open its editor,
// save it, read back what was saved, and open the saved item's editor again.

type Host = {
  name: string;
  skip?: string;
  types: string[];
  keep(request: APIRequestContext): Promise<() => Promise<void>>;
  open(page: Page, request: APIRequestContext, command: string): Promise<Args>;
  save(page: Page, request: APIRequestContext): Promise<Saved>;
  reopen(page: Page): Promise<Args>;
};

const DIALOG = 'tblCommandEditor';
const dialogArgs = (page: Page): Args => ({ scope: page.locator(`#commandEditorPopup #${DIALOG}`), tbl: DIALOG });

// The Command Editor dialog, opened for `command`.
async function editorOpened(page: Page, command: string) {
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue(command, { timeout: 15_000 });
  await settled(dialog);
  return dialogArgs(page);
}
async function acceptEditor(page: Page) {
  const dialog = page.locator('#commandEditorPopup');
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect(dialog).toBeHidden();
}

// A row of commandPresets.php, scheduler.php or recurringtasks.php: a
// .cmdTmplCommand select and an Edit button, both opening EditCommandTemplate.
async function editTemplateRow(page: Page, row: Locator, command: string) {
  await row.locator('input[value=Edit]').click();
  return editorOpened(page, command);
}

// The row whose name box holds NAME (filled in by script, so not an attribute).
async function namedRow(page: Page, rows: string, name: string) {
  const all = page.locator(rows);
  await expect.poll(() => all.locator(name).evaluateAll((ns, n) => ns.filter((i) => (i as HTMLInputElement).value === n).length, NAME),
    { timeout: 15_000 }).toBe(1);
  const index = await all.locator(name).evaluateAll((ns, n) => ns.findIndex((i) => (i as HTMLInputElement).value === n), NAME);
  return all.nth(index);
}

const PRESETS = 'api/configfile/commandPresets.json';
const TASKS = 'api/configfile/recurringtasks.json';
const GPIO = 'api/configfile/gpio.json';

const presets: Host = {
  name: 'Command Presets',
  types: ['conditionlist', 'commandlist', 'expression', 'subcommand'],
  async keep(request) {
    const before = await keep(request, PRESETS);
    return async () => put(request, PRESETS, before ?? '{}');
  },
  async open(page, request, command) {
    const file = JSON.parse((await keep(request, PRESETS)) ?? '{}');
    const commands = [...(file.commands ?? []), { name: NAME, presetSlot: 0, command, args: [], multisyncCommand: false, multisyncHosts: '' }];
    await put(request, PRESETS, { ...file, commands });
    return this.reopen(page);
  },
  async reopen(page) {
    await page.goto('/commandPresets.php');
    const row = await namedRow(page, '#tblCommandsBody > tr', '.cmdTmplName');
    return editTemplateRow(page, row, await row.locator('.cmdTmplCommand').inputValue());
  },
  async save(page, request) {
    await acceptEditor(page);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('commandPresets.json'));
    await page.locator('button[value=Save]').click();
    expect((await posted).ok()).toBe(true);
    return ((await (await request.get(PRESETS)).json()).commands as any[]).find((c) => c.name === NAME);
  },
};

const year = new Date().getFullYear();
const scheduler: Host = {
  name: 'Scheduler',
  types: ['conditionlist', 'commandlist', 'expression', 'subcommand'],
  async keep(request) {
    const before = await (await request.get('/api/schedule')).json();
    return async () => {
      await request.post('/api/schedule', { data: before });
      await request.post('/api/schedule/reload');
    };
  },
  async open(page, request, command) {
    // A disabled entry, so the reload doesn't run it; the test's is the last.
    const schedule = await (await request.get('/api/schedule')).json();
    schedule.push({ enabled: 0, day: 7, type: 'command', playlist: '', command, args: [], startTime: '23:59:00',
      endTime: '23:59:00', startDate: `${year}-01-01`, endDate: `${year}-01-01`, repeat: 0, stopType: 0 });
    expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
    return this.reopen(page);
  },
  async reopen(page) {
    await page.goto('/scheduler.php');
    const row = page.locator('#tblScheduleBody > tr').last();
    await expect(row.locator('.cmdTmplCommand')).not.toHaveValue('', { timeout: 15_000 });
    return editTemplateRow(page, row, await row.locator('.cmdTmplCommand').inputValue());
  },
  async save(page, request) {
    await acceptEditor(page);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.evaluate(() => (window as any).SaveSchedule());
    expect((await posted).ok()).toBe(true);
    const schedule = await (await request.get('/api/schedule')).json();
    return schedule[schedule.length - 1];
  },
};

const recurring: Host = {
  name: 'Recurring Tasks',
  types: ['conditionlist', 'commandlist', 'expression', 'subcommand'],
  async keep(request) {
    const before = await keep(request, TASKS);
    return async () => {
      await put(request, TASKS, before ?? '[]');
      await request.post('api/fppd/recurringtasks', { data: { command: 'reload' } });
    };
  },
  async open(page, request, command) {
    // Disabled, so fppd doesn't run it.
    const tasks = JSON.parse((await keep(request, TASKS)) ?? '[]');
    tasks.push({ name: NAME, enabled: false, intervalMS: 60000, type: 'command', preset: '', command, args: [],
      resultVariable: '', persistResult: false });
    await put(request, TASKS, tasks);
    return this.reopen(page);
  },
  async reopen(page) {
    await page.goto('/recurringtasks.php');
    const row = await namedRow(page, '#tblTasksBody > tr', '.ptTmplName');
    const a = await editTemplateRow(page, row, await row.locator('.cmdTmplCommand').inputValue());
    // The task's own section, added to the same dialog.
    await expect(page.locator('#commandEditorPopup')).toContainText('Result Variable / Filter');
    return a;
  },
  async save(page, request) {
    await acceptEditor(page);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('recurringtasks.json'));
    await page.locator('button', { hasText: /^Save$/ }).click();
    expect((await posted).ok()).toBe(true);
    return (JSON.parse((await keep(request, TASKS)) ?? '[]') as any[]).find((t) => t.name === NAME);
  },
};

const PL_TBL = 'playlistEntryCommandOptions';
const playlist: Host = {
  name: 'Playlist Editor',
  // The inline If's Add Command is the #3209 regression spec's.  Set
  // Variable's Set To shows no Expression row here (UpdateChildVisibility
  // walks the entry type's arguments, not the command's), so it isn't tested.
  types: ['conditionlist', 'subcommand'],
  async keep(request) {
    return async () => { await request.delete(`/api/playlist/${NAME}`); };
  },
  async open(page, request, command) {
    const r = await request.post(`/api/playlist/${NAME}`, {
      data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
    });
    expect(r.ok()).toBe(true);
    await openPlaylist(page);
    // New Entry, once Bootstrap's show transition is over.
    await page.evaluate(() => {
      (window as any).fppTestsModalShown = false;
      document.addEventListener('shown.bs.modal', () => { (window as any).fppTestsModalShown = true; }, { once: true });
    });
    await page.locator('.playlistEntriesAddNewBtn').first().click();
    await page.waitForFunction(() => (window as any).fppTestsModalShown);
    await page.selectOption('#pe_type', 'command');
    await page.selectOption('#playlistEntryOptions_arg_1', command);
    return { scope: page.locator(`#${PL_TBL}`), tbl: PL_TBL };
  },
  async reopen(page) {
    await openPlaylist(page);
    await page.locator('.playlistRowEditButton').first().click();
    const modal = page.locator('.modal.show');
    await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
    return { scope: page.locator(`#${PL_TBL}`), tbl: PL_TBL };
  },
  async save(page, request) {
    const modal = page.locator('.modal.show');
    const rows = page.locator('#tblPlaylistMainPlaylist tr.playlistRow');
    await modal.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(rows).toHaveCount(1);
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
    await page.getByRole('button', { name: 'Save Playlist' }).click();
    expect((await saved).ok()).toBe(true);
    return (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
  },
};
async function openPlaylist(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}

let restoreGpioSettings: () => void = () => {};
const gpio: Host = {
  name: 'GPIO',
  skip: container ? undefined : 'changes the player\'s GPIO config, and needs the container\'s test pins',
  types: ['conditionlist', 'commandlist', 'expression', 'subcommand'],
  async keep(request) {
    // A GPIO save sets the restart-needed flag in the settings file.
    restoreGpioSettings = snapshotSettings();
    const before = await keep(request, GPIO);
    return async () => {
      await put(request, GPIO, before ?? '[]');
      restoreGpioSettings();
    };
  },
  async open(page, request, command) {
    await put(request, GPIO, [{ pin: 'TF-1', enabled: true, mode: 'gpio', desc: NAME, debounceTime: 100,
      debounceEdge: 'both', rising: [], falling: [], holdTime: 0, hold: [] }]);
    const modal = await openGpioEdit(page);
    await modal.locator('button', { hasText: 'Add Command' }).first().click();
    await expect(page.locator('#commandEditorPopup #btnSaveEditorCommand')).toHaveValue('Add Command', { timeout: 15_000 });
    await page.locator('#commandEditorPopup #editorCommand').selectOption(command);
    return editorOpened(page, command);
  },
  async reopen(page) {
    const modal = await openGpioEdit(page);
    await modal.locator('#gpioModal_rising_list button[title=Edit]').click();
    await expect(page.locator('#commandEditorPopup #btnSaveEditorCommand')).toHaveValue('Save Command', { timeout: 15_000 });
    return dialogArgs(page);
  },
  async save(page, request) {
    await acceptEditor(page);
    await expect(page.locator('#gpioModal_rising_list .cmd-label')).toHaveCount(1);
    await page.locator('#gpioEditModal button[onclick="saveGPIOModal()"]').click();
    await page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
    await expect.poll(async () => ((await (await request.get(GPIO)).json()) as any[])[0].rising.length, { timeout: 15_000 }).toBe(1);
    return ((await (await request.get(GPIO)).json()) as any[])[0].rising[0];
  },
};
async function openGpioEdit(page: Page) {
  await page.goto('/gpio.php');
  const card = page.locator('.gpio-trigger-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button', { hasText: 'Edit' }).click();
  const modal = page.locator('#gpioEditModal');
  await expect(modal).toBeVisible();
  await settled(modal);
  return modal;
}

// ---------------------------------------------------------------------------

let restore: () => Promise<void> = async () => {};
let uiLevel = '0';
let errors: string[] = [];

for (const host of [presets, scheduler, recurring, playlist, gpio]) {
  test.describe(host.name, () => {
    if (host.skip) test.skip(true, host.skip);

    test.beforeEach(async ({ page, request }) => {
      uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
      // If, Set Variable and Test Start are offered from the Advanced level up.
      await request.put('/api/settings/uiLevel', { data: '1' });
      restore = await host.keep(request);
      errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
    });
    test.afterEach(async ({ request }) => {
      await restore();
      await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
      expect(errors, 'the page threw').toEqual([]);
    });

    for (const name of host.types) {
      const type = TYPES[name];
      test(`${type.command}'s ${name} argument is edited, saved and opened again`, async ({ page, request }) => {
        const a = await host.open(page, request, type.command);
        await type.edit(page, a);
        const saved = await host.save(page, request);
        expect(saved.command).toBe(type.command);
        type.saved(saved.args);
        await type.reopened(page, await host.reopen(page));
      });
    }
  });
}
