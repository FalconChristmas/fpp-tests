import { test, expect } from './fixtures';
import { whenModalShown } from './dialogs';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// fpp.js's FileChooser() is drawn by PrintArgInputs beside every argument of
// type "file", so it shows up wherever a playlist entry or a command is
// edited.  #3209 (fix 155bad634) was a widget like it tested in one host and
// broken in another, so the chooser is driven here in each: opened on a fresh
// page, a file picked, the item saved, the saved config read back, and the
// item opened again to see the chooser start from the file it was given.
//
// FPP's own commands have no file argument, and its playlist entries one (an
// Image entry's file; playlist-file-chooser and playlist-image-entry-path
// test its chooser opening and picking).  Plugins add commands with any
// argument in commands/descriptions.json, so the command hosts are reached
// through a plugin command whose one argument is a file from the images
// directory, which writes what it was given to a file when it runs.

test.skip(!container, 'installs a plugin and seeds images inside the run-web.sh container');

const NAME = 'fpp-tests-filehosts';
const PLUGIN = 'fpp-tests-filechooser';
const PLUGIN_DIR = `/home/fpp/media/plugins/${PLUGIN}`;
const COMMAND = 'FPPTests Choose File';
const ARG = 'fppTestsFile';
const RAN = '/tmp/fpp-tests-filechooser.args';
const IMAGE_DIR = '/home/fpp/media/images';
const IMAGES = ['fpp-tests-filehosts-a.png', 'fpp-tests-filehosts-b.png'];
// The file picked; the other is there so the pick is a choice.
const PICK = IMAGES[1];

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

// Once a dialog has faded in: closed during the fade, an fppDialog stays open.
const settled = (modal: Locator) => modal.evaluate((el) => new Promise<void>((resolve) => {
  const m = (window as any).bootstrap.Modal.getInstance(el);
  if (!m || !m._isTransitioning) resolve();
  else el.addEventListener('shown.bs.modal', () => resolve(), { once: true });
}));

// Where the file argument is drawn: the row PrintArgInputs put it in, the
// argument's class, and the dialog the host edits it in.
type Field = { scope: Locator; arg: string; host: Locator };
const input = (f: Field) => f.scope.locator(`input.arg_${f.arg}`);

// ---------------------------------------------------------------------------
// The hosts: put a new item on the page and open its editor at the file
// argument, save it and return the saved file, and open the saved item again.

type Host = {
  name: string;
  keep(request: APIRequestContext): Promise<() => Promise<void>>;
  open(page: Page, request: APIRequestContext): Promise<Field>;
  save(page: Page, request: APIRequestContext): Promise<string>;
  reopen(page: Page): Promise<Field>;
};

const DIALOG = '#commandEditorPopup';
const dialogField = (page: Page): Field =>
  ({ scope: page.locator(`${DIALOG} #tblCommandEditor`), arg: ARG, host: page.locator(DIALOG) });

async function editorOpened(page: Page) {
  const dialog = page.locator(DIALOG);
  await expect(dialog.locator('#editorCommand')).toHaveValue(COMMAND, { timeout: 15_000 });
  await settled(dialog);
  return dialogField(page);
}
async function acceptEditor(page: Page) {
  const dialog = page.locator(DIALOG);
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect(dialog).toBeHidden();
}

// The row of commandPresets.php whose name box holds NAME (filled in by
// script, so not an attribute).
async function namedRow(page: Page, rows: string, name: string) {
  const all = page.locator(rows);
  await expect.poll(() => all.locator(name).evaluateAll((ns, n) => ns.filter((i) => (i as HTMLInputElement).value === n).length, NAME),
    { timeout: 15_000 }).toBe(1);
  const index = await all.locator(name).evaluateAll((ns, n) => ns.findIndex((i) => (i as HTMLInputElement).value === n), NAME);
  return all.nth(index);
}

const INSTANT = 'api/configfile/instantCommand.json';
const runCommand: Host = {
  name: 'Run FPP Command',
  async keep(request) {
    const before = await keep(request, INSTANT);
    return async () => put(request, INSTANT, before ?? '{}');
  },
  async open(page) {
    await this.reopen(page);
    await page.locator(`${DIALOG} #editorCommand`).selectOption(COMMAND);
    return editorOpened(page);
  },
  async reopen(page) {
    await page.goto('/index.php');
    await page.locator('button', { hasText: 'Run FPP Command' }).click();
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
    await settled(dialog);
    return dialogField(page);
  },
  async save(page, request) {
    // Run and Close keeps the command for next time, and runs it.
    const kept = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('instantCommand.json'));
    await acceptEditor(page);
    expect((await kept).ok()).toBe(true);
    await expect.poll(() => inPlayer('sh', '-c', `cat ${RAN} 2>/dev/null || true`).trim(),
      { message: 'what the plugin command was run with', timeout: 15_000 }).toBe(PICK);
    const saved = JSON.parse((await keep(request, INSTANT)) ?? '{}');
    expect(saved.command).toBe(COMMAND);
    return saved.args[0];
  },
};

const PRESETS = 'api/configfile/commandPresets.json';
const presets: Host = {
  name: 'Command Presets',
  async keep(request) {
    const before = await keep(request, PRESETS);
    return async () => put(request, PRESETS, before ?? '{}');
  },
  async open(page, request) {
    const file = JSON.parse((await keep(request, PRESETS)) ?? '{}');
    const commands = [...(file.commands ?? []),
      { name: NAME, presetSlot: 0, command: COMMAND, args: [], multisyncCommand: false, multisyncHosts: '' }];
    await put(request, PRESETS, { ...file, commands });
    return this.reopen(page);
  },
  async reopen(page) {
    await page.goto('/commandPresets.php');
    const row = await namedRow(page, '#tblCommandsBody > tr', '.cmdTmplName');
    await row.locator('input[value=Edit]').click();
    return editorOpened(page);
  },
  async save(page, request) {
    await acceptEditor(page);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('commandPresets.json'));
    await page.locator('button[value=Save]').click();
    expect((await posted).ok()).toBe(true);
    const saved = ((await (await request.get(PRESETS)).json()).commands as any[]).find((c) => c.name === NAME);
    expect(saved.command).toBe(COMMAND);
    return saved.args[0];
  },
};

const year = new Date().getFullYear();
const scheduler: Host = {
  name: 'Scheduler',
  async keep(request) {
    const before = await (await request.get('/api/schedule')).json();
    return async () => {
      await request.post('/api/schedule', { data: before });
      await request.post('/api/schedule/reload');
    };
  },
  async open(page, request) {
    // A disabled entry, so the reload doesn't run it; the test's is the last.
    const schedule = await (await request.get('/api/schedule')).json();
    schedule.push({ enabled: 0, day: 7, type: 'command', playlist: '', command: COMMAND, args: [], startTime: '23:59:00',
      endTime: '23:59:00', startDate: `${year}-01-01`, endDate: `${year}-01-01`, repeat: 0, stopType: 0 });
    expect((await request.post('/api/schedule', { data: schedule })).ok()).toBe(true);
    return this.reopen(page);
  },
  async reopen(page) {
    await page.goto('/scheduler.php');
    const row = page.locator('#tblScheduleBody > tr').last();
    await expect(row.locator('.cmdTmplCommand')).toHaveValue(COMMAND, { timeout: 15_000 });
    await row.locator('input[value=Edit]').click();
    return editorOpened(page);
  },
  async save(page, request) {
    await acceptEditor(page);
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.evaluate(() => (window as any).SaveSchedule());
    expect((await posted).ok()).toBe(true);
    const schedule = await (await request.get('/api/schedule')).json();
    const saved = schedule[schedule.length - 1];
    expect(saved.command).toBe(COMMAND);
    return saved.args[0];
  },
};

// The Playlist Editor draws an entry's arguments inline in its entry dialog,
// a Command entry's command arguments below them.
async function openPlaylist(page: Page) {
  await page.goto('/playlists.php');
  await page.locator('.playlistCard h3', { hasText: new RegExp(`^${NAME}$`) }).click();
  await expect(page.locator('#playlistEditor')).toHaveClass(/hasPlaylistDetailsLoaded/);
}
async function newEntry(page: Page, request: APIRequestContext, type: string) {
  const r = await request.post(`/api/playlist/${NAME}`, {
    data: { name: NAME, version: 4, desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], playlistInfo: {} },
  });
  expect(r.ok()).toBe(true);
  await openPlaylist(page);
  await whenModalShown(page, () => page.locator('.playlistEntriesAddNewBtn').first().click());
  await page.selectOption('#pe_type', type);
}
async function editEntry(page: Page) {
  await openPlaylist(page);
  await whenModalShown(page, () => page.locator('.playlistRowEditButton').first().click());
  const modal = page.locator('.modal.show');
  await expect(modal.locator('.modal-title')).toHaveText('Edit Entry');
  return modal;
}
async function saveEntry(page: Page, request: APIRequestContext) {
  const modal = page.locator('.modal.show');
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#tblPlaylistMainPlaylist tr.playlistRow')).toHaveCount(1);
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/playlist/${NAME}`);
  await page.getByRole('button', { name: 'Save Playlist' }).click();
  expect((await saved).ok()).toBe(true);
  return (await (await request.get(`/api/playlist/${NAME}`)).json()).mainPlaylist[0];
}

const commandEntry: Host = {
  name: 'Playlist Editor, Command entry',
  async keep(request) {
    return async () => { await request.delete(`/api/playlist/${NAME}`); };
  },
  async open(page, request) {
    await newEntry(page, request, 'command');
    await page.selectOption('#playlistEntryOptions_arg_1', COMMAND);
    return { scope: page.locator('#playlistEntryCommandOptions'), arg: ARG, host: page.locator('.modal.show') };
  },
  async reopen(page) {
    const modal = await editEntry(page);
    return { scope: page.locator('#playlistEntryCommandOptions'), arg: ARG, host: modal };
  },
  async save(page, request) {
    const entry = await saveEntry(page, request);
    expect(entry.command).toBe(COMMAND);
    return entry.args[0];
  },
};

const imageEntry: Host = {
  name: 'Playlist Editor, Image entry',
  async keep(request) {
    return async () => { await request.delete(`/api/playlist/${NAME}`); };
  },
  async open(page, request) {
    await newEntry(page, request, 'image');
    return { scope: page.locator('#playlistEntryOptions'), arg: 'imagePath', host: page.locator('.modal.show') };
  },
  async reopen(page) {
    const modal = await editEntry(page);
    return { scope: page.locator('#playlistEntryOptions'), arg: 'imagePath', host: modal };
  },
  async save(page, request) {
    const entry = await saveEntry(page, request);
    expect(entry.type).toBe('image');
    return entry.imagePath;
  },
};

// ---------------------------------------------------------------------------

// Opens the chooser from the field's Choose File, once its list has loaded.
async function openChooser(page: Page, f: Field) {
  await f.scope.locator(`.arg_row_${f.arg} input[value="Choose File"]`).click();
  const chooser = page.locator('#fileChooserPopup');
  await expect(chooser.locator('#fileChooserSelect option', { hasText: PICK })).toHaveCount(1, { timeout: 10_000 });
  return chooser;
}

let restore: () => Promise<void> = async () => {};

test.beforeEach(async ({ request }) => {
  // A script plugin (callbacks.sh, so fppd loads it), whose command writes
  // its arguments to RAN.
  inPlayer('sh', '-c', `set -e; rm -rf ${PLUGIN_DIR} ${RAN}; mkdir -p ${PLUGIN_DIR}/commands; cd ${PLUGIN_DIR}
    printf '#!/bin/sh\\ncase "$1" in --list) echo playlist ;; esac\\nexit 0\\n' > callbacks.sh; chmod 755 callbacks.sh
    printf '#!/bin/sh\\nprintf "%%s\\\\n" "$@" > ${RAN}\\n' > commands/run.sh; chmod 755 commands/run.sh
    printf '[{"name":"${COMMAND}","script":"run.sh","args":[{"name":"${ARG}","description":"File","type":"file","directory":"images","optional":false}]}]\\n' > commands/descriptions.json
    ${IMAGES.map((i) => `printf x > ${IMAGE_DIR}/${i}`).join('; ')}`);
  const load = await request.post(`/api/fppd/plugin/${PLUGIN}/load`);
  expect(load.ok(), await load.text()).toBe(true);
  const commands = (await (await request.get('/api/commands')).json()) as { name: string; args: { type: string }[] }[];
  expect(commands.find((c) => c.name === COMMAND)?.args.map((a) => a.type), 'fppd describes the plugin command').toEqual(['file']);
});

test.afterEach(async ({ request }) => {
  await restore();
  restore = async () => {};
  await request.post(`/api/fppd/plugin/${PLUGIN}/unload`);
  inPlayer('rm', '-rf', PLUGIN_DIR, RAN, ...IMAGES.map((i) => `${IMAGE_DIR}/${i}`));
});

for (const host of [runCommand, presets, scheduler, commandEntry, imageEntry]) {
  test(`${host.name}: a file picked in the chooser is saved, and the chooser opens on it again`, async ({ page, request }) => {
    restore = await host.keep(request);
    const f = await host.open(page, request);
    await expect(input(f)).toHaveValue('');

    const chooser = await openChooser(page, f);
    await expect(chooser.locator('#fileChooserDir')).toHaveText('images');
    await chooser.locator('#fileChooserSelect').selectOption(PICK);
    await expect(input(f), 'the pick reached the field').toHaveValue(PICK);
    await expect(chooser).toBeHidden();
    await expect(f.host, "the host's dialog stays open").toBeVisible();

    expect(await host.save(page, request), 'the saved file').toBe(PICK);

    const again = await host.reopen(page);
    await expect(input(again)).toHaveValue(PICK);
    const reopened = await openChooser(page, again);
    await expect(reopened.locator('#fileChooserFile')).toHaveText(PICK);
    await expect(reopened.locator('#fileChooserSelect')).toHaveValue(PICK);
  });
}
