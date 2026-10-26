import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';
import { snapshotSettings } from './settings-file';

// The GPIO Inputs page (gpio.php): a card per input, listing the commands
// each edge runs, and an edit dialog whose command lists use the command
// editor.  The container's fppd offers its TF-1..TF-20 test pins (files in
// /tmp), so the page has pins to configure.  fppd reads config/gpio.json at
// start, so what it does with a saved input is checked in
// scenarios/test_command_preset_refs.py, from the same JSON.

test.skip(!container, 'changes the player\'s GPIO config');

const GPIO = 'api/configfile/gpio.json';
const PRESETS = 'api/configfile/commandPresets.json';
const PRESET = 'fpp-tests gpio preset';

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

const input = (extra: Record<string, unknown>) => ({
  pin: 'TF-1', enabled: true, mode: 'gpio', desc: 'fpp-tests input', debounceTime: 100, debounceEdge: 'both',
  rising: [], falling: [], holdTime: 0, hold: [], ...extra,
});

let saved: Record<string, string | null> = {};
// A GPIO save sets the restart-needed flag in the settings file, which
// changes other pages (Pixel Strings' table grows header rows); put it back.
let restoreSettings: () => void = () => {};
test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  saved = { [GPIO]: await keep(request, GPIO), [PRESETS]: await keep(request, PRESETS) };
});
test.afterEach(async ({ request }) => {
  await put(request, GPIO, saved[GPIO] ?? '[]');
  await put(request, PRESETS, saved[PRESETS] ?? '{}');
  restoreSettings();
});

async function openGPIO(page: Page) {
  await page.goto('/gpio.php');
  await expect(page.locator('.gpio-trigger-card').first()).toBeVisible({ timeout: 15_000 });
  return page.locator('.gpio-trigger-card').first();
}

// The labels fppd gives a command's arguments, in order.
async function argLabels(request: APIRequestContext, command: string): Promise<string[]> {
  const cmds = (await (await request.get('/api/commands')).json()) as any[];
  return cmds.find((c) => c.name === command).args.map((a: any) => a.description || a.name);
}

test('an input\'s card names each argument of its commands, with a dash for an empty one', async ({ page, request }) => {
  // Regression: 0ddb2533f.  The card listed only the values ("Start
  // Playlist: show, true, —"), which says nothing about which is which.
  await put(request, GPIO, [input({ rising: [{ command: 'Start Playlist', args: ['fpp-tests-pl', 'true', ''] }] })]);
  const labels = await argLabels(request, 'Start Playlist');
  const card = await openGPIO(page);
  await expect(card).toContainText(`Start Playlist: ${labels[0]}=fpp-tests-pl, ${labels[1]}=true, ${labels[2]}=—`);
});

test('an input\'s card says when a command goes to MultiSync remotes, and which', async ({ page, request }) => {
  // Regression: 7fa02d606.  multisyncCommand and multisyncHosts sit beside
  // args in the command JSON, and the card left them out: a command sent to
  // every remote read the same as one run only here.
  await put(request, GPIO, [input({
    rising: [{ command: 'Volume Set', args: ['50'], multisyncCommand: true, multisyncHosts: '' }],
    falling: [{ command: 'Volume Set', args: ['40'], multisyncCommand: true, multisyncHosts: '192.0.2.5,192.0.2.6' }],
    hold: [{ command: 'Volume Set', args: ['30'] }], holdTime: 1000,
  })]);
  const [volume] = await argLabels(request, 'Volume Set');
  const card = await openGPIO(page);
  // (The argument labels are 0ddb2533f's; this is about what follows them.)
  await expect(card).toContainText(new RegExp(`Volume Set: (${volume}=)?50 · Multisync: all remotes`));
  await expect(card).toContainText(new RegExp(`Volume Set: (${volume}=)?40 · Multisync: 192\\.0\\.2\\.5,192\\.0\\.2\\.6`));
  // One that is not sent anywhere else says nothing about it.
  await expect(card).toContainText(new RegExp(`Volume Set: (${volume}=)?30(?! ·)`));
});

test('a Command Preset picked for an edge is saved as a reference to it, not a copy of its command', async ({ page, request }) => {
  // Regression: 594b7fcd7 (the GPIO half).  Picking a preset copied its
  // command and arguments into the list, so a later edit of the preset never
  // reached the input; now the list gets Trigger Command Preset with its name.
  await put(request, PRESETS, { commands: [{ name: PRESET, presetSlot: 0,
    command: 'Set Variable', args: ['fppTestsGpioRef', 'Value', 'first', '1', '0', '100', ''] }] });
  await put(request, GPIO, [input({})]);
  const card = await openGPIO(page);
  await card.locator('button', { hasText: 'Edit' }).click();
  const modal = page.locator('#gpioEditModal');
  await expect(modal).toBeVisible();
  await modal.locator('button', { hasText: 'Add Command' }).first().click();

  const editor = page.locator('#commandEditorPopup');
  await expect(editor.locator('#presetNames')).toBeVisible({ timeout: 15_000 });
  await editor.locator('#presetNames').selectOption(PRESET);
  await expect(editor.locator('#editorCommand')).toHaveValue('Trigger Command Preset');
  // Save Preset would overwrite the picked preset's own definition with a
  // command that triggers itself.
  await expect(editor.locator('#btnSaveDirectEditorCommand')).toBeHidden();
  await editor.locator('#btnSaveEditorCommand').click();

  await expect(page.locator('#gpioModal_rising_list .cmd-label')).toHaveText(new RegExp(`^Trigger Command Preset: (.*=)?${PRESET}$`));
  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
  await expect.poll(async () => ((await (await request.get(GPIO)).json()) as any[])[0].rising
    .map((c: any) => ({ command: c.command, args: c.args })), { timeout: 15_000 })
    .toEqual([{ command: 'Trigger Command Preset', args: [PRESET] }]);
});
