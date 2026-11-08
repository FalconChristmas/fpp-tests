import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

// The Command Presets page (commandPresets.php): Clone copies the selected
// preset into a new row, rows are dragged to reorder them, and Save writes
// the table as it is to config/commandPresets.json.  The warning above the
// table lists presets whose command this player does not have.
// (command-presets-*.spec.ts: Delete, refused Saves, fppd running a preset.)
//
// A row button that is off carries the disableButtons class; on page load it
// has only the class (SetButtonState() adds the disabled attribute once it runs).

const FILE = 'api/configfile/commandPresets.json';
let before: string | null = null;

test.beforeEach(async ({ request }) => {
  const r = await request.get(FILE);
  before = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await request.post(FILE, { data: Buffer.from(before ?? '{"commands":[]}') });
});

const preset = (name: string, volume: number, o: object = {}) => ({
  name, command: 'Volume Set', args: [String(volume)], multisyncCommand: false, multisyncHosts: '', presetSlot: 0, ...o,
});
async function put(request: APIRequestContext, commands: object[]) {
  const r = await request.post(FILE, { data: Buffer.from(JSON.stringify({ commands })) });
  expect(r.ok(), await r.text()).toBe(true);
}
const stored = async (request: APIRequestContext) => ((await (await request.get(FILE)).json()).commands ?? []) as any[];

async function openPage(page: Page, rows: number) {
  await page.goto('/commandPresets.php');
  const all = page.locator('#tblCommandsBody > tr');
  await expect(all).toHaveCount(rows, { timeout: 15_000 });
  return all;
}
async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('commandPresets.json'));
  await page.locator('button[value="Save"]:visible').first().click();
  expect((await posted).ok()).toBe(true);
}
// A row is selected by a mousedown on it; the grip cell holds no input.
const pick = (row: Locator) => row.locator('td').first().dispatchEvent('mousedown');

test('Clone copies the selected preset, its command, arguments and slot, into a new row Save keeps', async ({ page, request }) => {
  await put(request, [preset('fpp-tests first', 10), preset('fpp-tests slotted', 25, { presetSlot: 3 })]);
  const rows = await openPage(page, 2);
  const clone = page.locator('button.cloneCmdButton:visible').first();
  await expect(clone).toHaveClass(/\bdisableButtons\b/);
  await pick(rows.nth(1));
  await expect(clone).not.toHaveClass(/\bdisableButtons\b/);
  await clone.click();
  await expect(rows).toHaveCount(3);
  const copy = rows.nth(2);
  await expect(copy.locator('.cmdTmplName')).toHaveValue('fpp-tests slotted');
  await expect(copy.locator('.cmdTmplCommand')).toHaveValue('Volume Set');
  await copy.locator('.cmdTmplName').fill('fpp-tests copy');
  await save(page);
  const after = await stored(request);
  expect(after.map((c) => c.name)).toEqual(['fpp-tests first', 'fpp-tests slotted', 'fpp-tests copy']);
  const { name: _a, ...orig } = after[1];
  const { name: _b, ...copied } = after[2];
  expect(copied).toEqual(orig);
  expect(copied).toMatchObject({ command: 'Volume Set', args: ['25'], presetSlot: 3 });
});

test('a preset dragged to the top is saved first', async ({ page, request }) => {
  await put(request, [preset('fpp-tests a', 10), preset('fpp-tests b', 20), preset('fpp-tests c', 30)]);
  const rows = await openPage(page, 3);
  const from = (await rows.nth(2).locator('td').first().boundingBox())!;
  const to = (await rows.nth(0).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 8, { steps: 4 });
  await page.mouse.move(to.x + from.width / 2, to.y + 3, { steps: 15 });
  await page.mouse.move(to.x + from.width / 2, to.y + 2, { steps: 2 });
  await page.mouse.up();
  await expect(rows.nth(0).locator('.cmdTmplName')).toHaveValue('fpp-tests c');
  await save(page);
  expect((await stored(request)).map((c) => c.name)).toEqual(['fpp-tests c', 'fpp-tests a', 'fpp-tests b']);
});

// Preset data with markup and quotes in every field the row shows: an
// unavailable command that would end an attribute, arguments and MultiSync
// hosts with handlers, and text that is already an entity.
const BAD_COMMAND = 'fpp-tests x" autofocus onfocus="window.fppTestsRan=1';
const markedUp = [
  // (No multisyncHosts: the page keeps one only for a MultiSync command.)
  { name: 'fpp-tests <img src=x onerror="window.fppTestsRan=2"> preset', command: BAD_COMMAND, args: [],
    multisyncCommand: false, presetSlot: 0 },
  { name: 'fpp-tests args', command: 'Set Variable',
    args: ['fppTestsVar<img src=x onerror="window.fppTestsRan=3">', 'Value', 'a &amp; b <b>c</b>', '1', '0', '100', ''],
    multisyncCommand: true, multisyncHosts: '<img src=x onerror="window.fppTestsRan=4">', presetSlot: 0 },
];
const ran = (page: Page) => page.evaluate(() => (window as any).fppTestsRan);

test('preset names, commands, arguments and hosts with markup are shown as text and saved as they were', async ({ page, request }) => {
  // Regression: 54c1cd6b6.  The unavailable-command warning, the unavailable command's
  // option, the row's argument and MultiSync previews and its tooltip were
  // all built as markup from the preset's text, so a handler in any of them
  // ran when the page loaded.  The row's hidden copy of the command was set
  // as markup and read back as text, so Save wrote "<b>c</b>" back as "c"
  // and "&amp;" as "&".
  await put(request, markedUp);
  const rows = await openPage(page, 2);
  const warning = page.locator('#commandPresetsWarning');
  await expect(warning.locator('li')).toHaveText(`${markedUp[0].name} - Command: ${BAD_COMMAND}`);
  const option = rows.nth(0).locator('.cmdTmplCommand option.invalidCommandOption');
  await expect(option).toHaveText(`${BAD_COMMAND} (unavailable)`);
  await expect(option).toHaveAttribute('value', BAD_COMMAND);
  expect(await option.getAttribute('autofocus')).toBeNull();
  await expect(rows.nth(1).locator('.cmdTmplArgs')).toContainText('a &amp; b <b>c</b>');
  await expect(rows.nth(1).locator('.cmdTmplMulticastInfo')).toContainText(markedUp[1].multisyncHosts);
  // (Each row's own tooltip icon is the one image a row should have.)
  await expect(page.locator('#tblCommandsBody img:not(.cmdTmplTooltipIcon), #commandPresetsWarning img, #tblCommandsBody .cmdTmplArgs b'))
    .toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await ran(page)).toBeUndefined();

  await save(page);
  expect(await stored(request)).toEqual(markedUp);
  await expect(warning.locator('li')).toHaveText(`${markedUp[0].name} - Command: ${BAD_COMMAND}`);
  await expect(page.locator('#commandPresetsWarning img')).toHaveCount(0);
  expect(await ran(page)).toBeUndefined();
});

test('a schedule command with markup in its arguments is saved back as it was', async ({ page, request }) => {
  // 54c1cd6b6: the Scheduler builds its command rows with the same template, and lost
  // markup and entities in a command's arguments on Save the same way.
  const before = await (await request.get('/api/schedule')).json();
  try {
    const year = new Date().getFullYear();
    const sched = [{ enabled: 0, day: 7, type: 'command', playlist: '', command: 'Set Variable',
      args: ['fppTestsVar<img src=x onerror="window.fppTestsRan=5">', 'Value', 'a &amp; b <b>c</b>', '1', '0', '100', ''],
      startTime: '12:00:00', endTime: '12:00:00', startDate: `${year}-01-01`, endDate: `${year + 1}-12-31`,
      repeat: 0, stopType: 0 }];
    expect((await request.post('/api/schedule', { data: sched })).ok()).toBe(true);
    const want = (await (await request.get('/api/schedule')).json())[0];
    await page.goto('/scheduler.php');
    await expect(page.locator('#tblScheduleBody > tr')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('#tblScheduleBody .cmdTmplArgs')).toContainText('a &amp; b <b>c</b>');
    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/schedule');
    await page.locator('input[value="Save"]:visible').first().click();
    expect((await posted).ok()).toBe(true);
    expect(await ran(page)).toBeUndefined();
    const got = (await (await request.get('/api/schedule')).json())[0];
    expect(got.args).toEqual(want.args);
    expect(got.command).toBe('Set Variable');
  } finally {
    await request.post('/api/schedule', { data: before });
  }
});

// Known bug (~/FUTURE.md, "Command Presets: Save keeps two presets with the same
// name", fpp 2edd0c0d7).  Passes as an expected failure until the page is fixed.

test('Save refuses two presets with the same name', async ({ page, request }) => {
  // Clone gives the copy the original's name and SaveCommands() checks only
  // for a missing name or command, so a copy not renamed is saved as a second
  // preset of that name; a command naming the preset then runs whichever
  // fppd finds first.  (The Recurring Tasks page refuses a name used twice.)
  test.fail();
  const original = [preset('fpp-tests twice', 10)];
  await put(request, original);
  const rows = await openPage(page, 1);
  await pick(rows.nth(0));
  await page.locator('button.cloneCmdButton:visible').first().click();
  await expect(rows).toHaveCount(2);
  const said: string[] = [];
  page.on('dialog', (d) => { said.push(d.message()); d.accept(); });
  await page.locator('button[value="Save"]:visible').first().click();
  await expect.poll(() => said.join('\n'), { timeout: 3000 }).toContain('fpp-tests twice');
  expect(await stored(request)).toEqual(original);
});
