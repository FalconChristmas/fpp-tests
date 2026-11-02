import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

// The Run FPP Command dialog (the footer's "Run FPP Command" button) has two
// ways to run: "Run and Close", the dialog's accept button, and "Run Now",
// which runs the command and leaves the dialog open for the next one.  What
// runs goes to fppd, whose variables show it.

const PRESETS = 'api/configfile/commandPresets.json';
const INSTANT = 'api/configfile/instantCommand.json';
const VAR_A = 'fppTestsRunNowA';
const VAR_B = 'fppTestsRunNowB';

const setVariable = (name: string, value: string) => ({ command: 'Set Variable', args: [name, 'Value', value, '1', '0', '100', ''] });

async function keep(request: APIRequestContext, path: string) {
  const r = await request.get(path);
  return r.ok() ? await r.text() : null;
}
async function put(request: APIRequestContext, path: string, body: unknown) {
  const r = await request.post(path, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}
const variable = async (request: APIRequestContext, name: string) =>
  ((await (await request.get('/api/variables')).json()) ?? {})[name]?.value;

let saved: Record<string, string | null> = {};
test.beforeEach(async ({ request }) => {
  saved = { [PRESETS]: await keep(request, PRESETS), [INSTANT]: await keep(request, INSTANT) };
});
test.afterEach(async ({ request }) => {
  for (const [path, body] of Object.entries(saved)) await put(request, path, body ?? '{}');
});

test('Run Now runs the dialog\'s command and leaves the dialog open; Run and Close runs it and closes', async ({ page, request }) => {
  // Regression: 5b341dcdb.  The popup runner could only accept (run and
  // close); running several commands or effects in a row meant reopening it
  // each time.  "Run Now" runs what is in the editor without closing it.
  await put(request, INSTANT, setVariable(VAR_A, 'first'));
  await page.goto('/index.php');
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toHaveValue('Set Variable', { timeout: 15_000 });
  const value = page.locator('#tblCommandEditor .arg_value');
  await expect(value).toHaveValue('first');
  await expect(dialog.locator('#btnSaveEditorCommand')).toHaveValue('Run and Close');
  await expect(dialog.locator('#btnRunEditorCommand')).toHaveValue('Run Now');

  await dialog.locator('#btnRunEditorCommand').click();
  await expect.poll(() => variable(request, VAR_A), { timeout: 10_000 }).toBe('first');
  await expect(dialog.locator('#editorCommand'), 'Run Now left the dialog open').toBeVisible();

  // Change the command in the open dialog and run again: the second run is
  // what is in the editor now.
  await page.locator('#tblCommandEditor .arg_name').fill(VAR_B);
  await value.fill('second');
  await dialog.locator('#btnRunEditorCommand').click();
  await expect.poll(() => variable(request, VAR_B), { timeout: 10_000 }).toBe('second');
  await expect(dialog.locator('#editorCommand')).toBeVisible();

  await value.fill('third');
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect.poll(() => variable(request, VAR_B), { timeout: 10_000 }).toBe('third');
  await expect(dialog.locator('#editorCommand'), 'Run and Close closes the dialog').toBeHidden();
});
