import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// The Run FPP Command dialog (the footer's "Run FPP Command" button): the
// command editor with its "Load Existing Command Preset" select, which lists
// the Command Presets.  The command the dialog runs goes to fppd, whose
// variables show which one ran.

const PRESETS = 'api/configfile/commandPresets.json';
const INSTANT = 'api/configfile/instantCommand.json';
const VAR = 'fppTestsRunDialog';

const setVariable = (value: string) => ({ command: 'Set Variable', args: [VAR, 'Value', value, '1', '0', '100', ''] });

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}

async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

let saved: Record<string, string | null> = {};

test.beforeEach(async ({ request }) => {
  saved = { [PRESETS]: await keep(request, PRESETS), [INSTANT]: await keep(request, INSTANT) };
});

test.afterEach(async ({ request }) => {
  for (const [path, body] of Object.entries(saved)) {
    await put(request, path, body ?? '{}');
  }
});

async function openDialog(page: Page) {
  await page.goto('/index.php');
  // The presets are fetched as the dialog opens; wait for them to arrive.
  const presets = page.waitForResponse((r) => r.url().includes('commandPresets.json'));
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  await presets;
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
  return dialog;
}

// The value the command editor shows for an argument.
const arg = (page: Page, name: string) => page.locator(`#tblCommandEditor .arg_${name}`);

test('with no command presets the preset select is hidden; with one it shows and lists it', async ({ page, request }) => {
  // Regression: 4b304d262.  The select was shown whenever the presets file
  // had a "commands" list, an empty one included: a select with nothing in it.
  await put(request, PRESETS, { commands: [] });
  let dialog = await openDialog(page);
  await page.waitForTimeout(500);
  await expect(dialog.locator('#presetNames')).toBeHidden();

  await put(request, PRESETS, { commands: [{ name: 'fpp-tests preset', presetSlot: 0, ...setVariable('preset') }] });
  dialog = await openDialog(page);
  await expect(dialog.locator('#presetNames')).toBeVisible();
  await expect(dialog.locator('#presetNames option')).toHaveText(['-- Select a Command Preset --', 'fpp-tests preset']);
});

test('picking a preset and then none puts back the command the dialog opened with, and that is what runs', async ({ page, request }) => {
  // Regression: 287717d1e.  Going back to "-- Select a Command Preset --"
  // left the preset's command in the fields and Save Preset enabled, so Run
  // ran the preset, not the command the dialog had opened with.
  await put(request, PRESETS, { commands: [{ name: 'fpp-tests preset', presetSlot: 0, ...setVariable('preset') }] });
  await put(request, INSTANT, setVariable('opened'));
  const dialog = await openDialog(page);
  await expect(dialog.locator('#editorCommand')).toHaveValue('Set Variable');
  await expect(arg(page, 'value')).toHaveValue('opened');
  const savePreset = dialog.locator('#btnSaveDirectEditorCommand');

  await dialog.locator('#presetNames').selectOption('fpp-tests preset');
  await expect(arg(page, 'value')).toHaveValue('preset');
  await expect(savePreset).toBeEnabled();

  await dialog.locator('#presetNames').selectOption('');
  await expect(arg(page, 'value'), 'the value once no preset is picked').toHaveValue('opened');
  await expect(savePreset).toBeDisabled();

  // The receiving end: what fppd is told to run.
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect.poll(async () => ((await (await request.get('/api/variables')).json()) ?? {})[VAR]?.value,
    { timeout: 10_000 }).toBe('opened');
});
