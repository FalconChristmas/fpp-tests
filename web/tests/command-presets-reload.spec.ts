import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// Saving Command Presets (commandPresets.php) needs no fppd restart: fppd
// reloads commandPresets.json when it changes on disk.  So the page must not
// raise the restart flag, and the running fppd must run the saved presets.

test.skip(!container, 'changes the player\'s command presets');

const VAR = 'fppTestsPresetReload';
const preset = (name: string) => ({
  name, command: 'Set Variable', args: [VAR, 'Value', name, '1', '0', '100', ''],
  multisyncCommand: false, multisyncHosts: '', presetSlot: 0,
});

let before: string | null = null;
async function putPresets(request: APIRequestContext, body: string) {
  const r = await request.post('/api/configfile/commandPresets.json', { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}
const restartFlag = async (request: APIRequestContext) =>
  String((await (await request.get('/api/settings/restartFlag')).json()).value ?? '0');
const variable = async (request: APIRequestContext) =>
  String(((await (await request.get('/api/variables')).json()) ?? {})[VAR]?.value ?? '');
const trigger = (request: APIRequestContext, name: string) =>
  request.post('/api/command', { data: { command: 'Trigger Command Preset', args: [name] } });

test.beforeEach(async ({ request }) => {
  const r = await request.get('/api/configfile/commandPresets.json');
  before = r.ok() ? await r.text() : null;
  await putPresets(request, JSON.stringify({ commands: [preset('fpp-tests-reload-a')] }));
  await request.put('/api/settings/restartFlag', { data: '0' });
});
test.afterEach(async ({ request }) => {
  await putPresets(request, before ?? '{"commands": []}');
  await request.put('/api/settings/restartFlag', { data: '0' });
});

test('saving presets asks for no restart, and the running fppd runs the saved preset', async ({ page, request }) => {
  // Feature: fdf29237e.  The page set the (quick) restart flag on every
  // save, because fppd read the presets only at startup; fppd now reloads
  // the file when it changes, and the page no longer asks for a restart.
  await expect.poll(async () => { await trigger(request, 'fpp-tests-reload-a'); return variable(request); },
    { timeout: 15_000 }).toBe('fpp-tests-reload-a');

  await page.goto('/commandPresets.php');
  const rows = page.locator('#tblCommandsBody > tr');
  await expect(rows).toHaveCount(1, { timeout: 15_000 });
  const name = rows.first().locator('input.cmdTmplName');
  await expect(name).toHaveValue('fpp-tests-reload-a');
  await name.fill('fpp-tests-reload-b');
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' &&
    new URL(r.url()).pathname === '/api/configfile/commandPresets.json');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#jGrowl')).toContainText('Commands saved.');

  // The receiving end: fppd, the same process, runs the preset by its new
  // name (its Set Variable stores the preset's name, which the save kept
  // in the args).
  await request.post('/api/command', { data: { command: 'Set Variable', args: [VAR, 'Value', 'unset', '1', '0', '100', ''] } });
  await expect.poll(async () => (await trigger(request, 'fpp-tests-reload-b')).ok(),
    { timeout: 15_000, message: 'the saved preset to run without a restart' }).toBe(true);
  expect(await variable(request)).toBe('fpp-tests-reload-a');
  const old = await trigger(request, 'fpp-tests-reload-a');
  expect(old.ok(), 'the old name still ran after the save').toBe(false);

  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => String((window as any).settings.restartFlag))).toBe('0');
  expect(await restartFlag(request)).toBe('0');
});
