import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';

// A command whose argument picks a subcommand, in the Run FPP Command
// dialog: Overlay Model Effect's Effect and Test Start's Test Pattern
// (PrintArgInputs' subcommand select, SubCommandChanged).  The choice is a
// list from fppd, and the chosen effect's or test's own arguments follow it
// as their own controls (a select, a number, a slider, a colour); run, fppd
// starts that effect or test with them.

test.skip(!container, 'needs the overlay model run-web.sh seeds the player with');

const MODEL = 'fpp-tests-matrix';
const TBL = 'tblCommandEditor';

async function command(request: APIRequestContext, name: string, ...args: string[]) {
  const r = await request.post('/api/command', { data: { command: name, args } });
  expect(r.ok(), await r.text()).toBe(true);
}

let uiLevel = '0';
let errors: string[] = [];
test.beforeEach(async ({ request, page }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  // The overlay and test commands are offered from the Advanced level up.
  await request.put('/api/settings/uiLevel', { data: '3' });
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(async ({ request }) => {
  await command(request, 'Overlay Model Effect', MODEL, 'Enabled', 'Stop Effects');
  await request.put(`/api/overlays/model/${MODEL}/state`, { data: { State: 0 } });
  await command(request, 'Test Stop');
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
  expect(errors, 'the page threw').toEqual([]);
});

async function openDialog(page: Page, cmd: string) {
  await page.goto('/index.php');
  const presets = page.waitForResponse((r) => r.url().includes('commandPresets.json'));
  await page.locator('button', { hasText: 'Run FPP Command' }).click();
  await presets;
  const dialog = page.locator('#commandEditorPopup');
  await expect(dialog.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
  await dialog.locator('#editorCommand').selectOption(cmd);
  return dialog;
}
const arg = (page: Page, n: number) => page.locator(`#${TBL}_arg_${n}`);
const argRows = (page: Page) => page.locator(`#${TBL} tr[id*=_arg_][id$=_row]`);
const values = (sel: ReturnType<Page['locator']>) =>
  sel.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));

test("Overlay Model Effect's Effect brings that effect's own arguments, and runs it with them", async ({ page, request }) => {
  const effects: string[] = await (await request.get('/api/overlays/effects')).json();
  const bars = (await (await request.get('/api/overlays/effects/Bars')).json()).args;
  const dialog = await openDialog(page, 'Overlay Model Effect');
  const effect = arg(page, 3);
  expect(await values(effect)).toEqual(effects);
  // The first effect is chosen, and its arguments (if any) are shown.
  await expect(effect).toHaveValue(effects[0]);

  await effect.selectOption('Bars');
  await expect(argRows(page)).toHaveCount(3 + bars.length);
  // Each of Bars' arguments as its type asks: a list, a number with its
  // bounds, a slider showing its value, a colour.
  const control = (name: string) => page.locator(`#${TBL} .arg_${name}`).first();
  expect(await values(control('Direction'))).toEqual(['Up', 'Down', 'Left', 'Right']);
  await expect(control('time')).toHaveAttribute('type', 'number');
  await expect(control('time')).toHaveAttribute('min', '1');
  await expect(control('time')).toHaveAttribute('max', '60000');
  await expect(control('time')).toHaveValue('2000');
  await expect(control('iterations')).toHaveAttribute('type', 'range');
  const iterations = control('iterations');
  const shown = page.locator(`#${await iterations.getAttribute('id')}CurrentValue`);
  await expect(shown).toHaveText('1');
  await iterations.fill('4');
  await expect(shown).toHaveText('4');
  const color = page.locator(`#${TBL} input[type=color]`).first();
  await expect(color).toHaveValue('#ff0000');

  // Another effect takes Bars' arguments away; back to Bars brings them back
  // at their defaults.
  const other = effects.find((e) => e !== 'Bars' && e !== 'Stop Effects' && !e.startsWith('WLED'))!;
  const otherArgs = (await (await request.get(`/api/overlays/effects/${encodeURIComponent(other)}`)).json()).args ?? [];
  await effect.selectOption(other);
  await expect(argRows(page)).toHaveCount(3 + otherArgs.length);
  await effect.selectOption('Bars');
  await expect(argRows(page)).toHaveCount(3 + bars.length);
  await control('Direction').selectOption('Left');

  // Run on the model: fppd runs Bars there.
  await page.locator(`#${TBL}_arg_1_checks label`, { hasText: new RegExp(`^${MODEL}$`) }).click();
  await expect(arg(page, 1)).toHaveValue(MODEL);
  const sent = page.waitForRequest((r) => r.method() === 'POST' && /api\/command(\?|$)/.test(r.url()));
  await dialog.locator('#btnSaveEditorCommand').click();
  const ran = JSON.parse((await sent).postData() || '{}');
  expect(ran.command).toBe('Overlay Model Effect');
  expect(ran.args.slice(0, 4)).toEqual([MODEL, 'Enabled', 'Bars', 'Left']);
  expect(ran.args[4]).toBe('2000');
  await expect.poll(async () => (await (await request.get(`/api/overlays/model/${MODEL}`)).json()).effectName, { timeout: 10_000 }).toBe('Bars');
});

test("Test Start's Test Pattern brings the pattern's arguments, and starts that test", async ({ page, request }) => {
  const tests: string[] = await (await request.get('/api/fppd/testing/tests/')).json();
  const dialog = await openDialog(page, 'Test Start');
  await expect(arg(page, 1)).toHaveValue('1000');
  const pattern = arg(page, 2);
  expect(await values(pattern)).toEqual(tests);

  await pattern.selectOption('RGB Single Color');
  // Channel Range/Model (a list to pick from or type in) and Color.
  await expect(argRows(page)).toHaveCount(4);
  const range = arg(page, 3);
  await expect(range).toHaveAttribute('list', `${TBL}_arg_3_list`);
  await expect(page.locator(`#${TBL}_arg_3_list option[value="1-8"]`)).toHaveCount(1);
  await expect(page.locator(`#${TBL}_arg_3_list option[value="${MODEL}"]`)).toHaveCount(1);
  await expect(arg(page, 4)).toHaveAttribute('type', 'color');

  await pattern.selectOption('RGB Cycle');
  await expect(argRows(page)).toHaveCount(4);
  expect(await values(arg(page, 4))).toContain('R-G-B-W');
  await arg(page, 3).fill('1-150');
  await arg(page, 4).selectOption('R-G-B');
  await dialog.locator('#btnSaveEditorCommand').click();
  await expect.poll(async () => (await (await request.get('/api/testmode')).json()).enabled, { timeout: 10_000 }).toBe(1);
  const mode = await (await request.get('/api/testmode')).json();
  expect(mode).toMatchObject({ mode: 'RGBCycle', cycleMS: 1000 });
});
