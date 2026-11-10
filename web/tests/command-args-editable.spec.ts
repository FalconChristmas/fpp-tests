import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// PrintArgsInputsForEditable() in fpp.js: the command editor plugins use
// (fpp-osc's command per OSC path), where every argument is a text box so a
// value can be a placeholder the plugin fills in later (%1, a path element)
// rather than only what a checkbox, number box or list allows.  A plugin
// gives CommandSelectChanged() and PopulateExistingCommand() this printer and
// reads the values back with CommandToJSON(); here a table and a command
// select are put on a page of the player's as fpp-osc's plugin page has them.

test.skip(!container, 'needs the overlay model run-web.sh seeds the player with');

const TABLE = 'fppTestsCmdTable';
const SELECT = 'fppTestsCmdSelect';

async function editor(page: Page) {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).PrintArgsInputsForEditable === 'function');
  await page.evaluate(([table, select]) => {
    const w = window as any;
    // The overlay commands are offered from the Advanced UI level up.
    w.settings.uiLevel = '3';
    w.$('body').append(`<table id='${table}'><tr><td>Command:</td><td><select id='${select}'><option value=''></option></select></td></tr></table>`);
    w.LoadCommandList(w.$('#' + select));
  }, [TABLE, SELECT]);
}
const choose = (page: Page, command: string) => page.evaluate(([table, select, c]) => {
  const w = window as any;
  w.$('#' + select).val(c);
  w.CommandSelectChanged(select, table, false, w.PrintArgsInputsForEditable);
}, [TABLE, SELECT, command]);
const toJSON = (page: Page) => page.evaluate(([table, select]) =>
  (window as any).CommandToJSON(select, table, {}, true), [TABLE, SELECT]);
const arg = (page: Page, n: number) => page.locator(`#${TABLE}_arg_${n}`);
const argRow = (page: Page, n: number) => page.locator(`#${TABLE}_arg_${n}_row`);

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => {
  expect(errors, 'the page threw').toEqual([]);
});

test('every argument is a text box, filled with its default, and comes back as typed', async ({ page, request }) => {
  await editor(page);
  await choose(page, 'Effect Start');
  const effects = await (await request.get('/api/effects')).json();
  // Model lists are asked for as OverlayModelContentListUrl() rewrites them
  // (with submodels and groups).
  const modelsUrl = await page.evaluate(() => (window as any).OverlayModelContentListUrl('api/models?simple=true'));
  expect(modelsUrl).not.toBe('api/models?simple=true');
  const models = await (await request.get('/' + modelsUrl)).json();

  // Effect, Start Channel, Loop, Background, If Not Running, Model.
  await expect(page.locator(`#${TABLE} tr[id*=_arg_][id$=_row]`)).toHaveCount(6);
  for (let n = 1; n <= 6; n++) await expect(arg(page, n)).toHaveAttribute('type', 'text');
  await expect(argRow(page, 1)).toContainText('Effect Name (string):');
  await expect(argRow(page, 2)).toContainText('Start Channel (int):');
  // A bool is written out: its default, or false.
  await expect(arg(page, 3)).toHaveValue('true');
  await expect(arg(page, 4)).toHaveValue('false');
  await expect(arg(page, 5)).toHaveValue('false');
  await expect(arg(page, 3)).toHaveAttribute('data-arg-type', 'bool');
  // A list argument suggests its list, and still takes anything typed.
  await expect(arg(page, 1)).toHaveAttribute('list', `${TABLE}_arg_1_list`);
  expect(await page.locator(`#${TABLE}_arg_1_list option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(effects);
  expect(await page.locator(`#${TABLE}_arg_6_list option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value)))
    .toEqual(Array.isArray(models) ? models : Object.keys(models));

  await arg(page, 1).fill('%1');
  await arg(page, 2).fill('%2');
  await arg(page, 4).fill('%3');
  await arg(page, 6).fill('fpp-tests-matrix');
  expect(await toJSON(page)).toEqual({
    command: 'Effect Start', multisyncCommand: false, multisyncHosts: '',
    args: ['%1', '%2', 'true', '%3', 'false', 'fpp-tests-matrix'],
    argTypes: ['string', 'int', 'bool', 'bool', 'bool', 'string'],
  });

  // Another command replaces the rows.
  await choose(page, 'Overlay Model Fill');
  await expect(page.locator(`#${TABLE} tr[id*=_arg_][id$=_row]`)).toHaveCount(3);
  await expect(argRow(page, 3)).toContainText('Color (color):');
  await expect(arg(page, 3)).toHaveValue('#FF0000');
  // A list given in the command itself is suggested too.
  expect(await page.locator(`#${TABLE}_arg_2_list option`).evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value)))
    .toEqual(["Don't Set", 'Enabled', 'Transparent', 'TransparentRGB']);
});

test("a subcommand is a choice, and its own arguments follow it, as text boxes, numbered on", async ({ page, request }) => {
  await editor(page);
  await choose(page, 'Overlay Model Effect');
  const effects: string[] = await (await request.get('/api/overlays/effects')).json();
  const sub = arg(page, 3);
  // The effect is a select of fppd's overlay effects, the first one chosen.
  expect(await sub.evaluate((s) => (s as HTMLSelectElement).tagName)).toBe('SELECT');
  expect(await sub.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).toEqual(effects);
  await expect(arg(page, 2)).toHaveValue('Enabled');

  // Bars: its arguments from fppd, after the effect, as text.
  const bars = (await (await request.get('/api/overlays/effects/Bars')).json()).args;
  await sub.selectOption('Bars');
  await expect(page.locator(`#${TABLE} tr[id*=_arg_][id$=_row]`)).toHaveCount(3 + bars.length);
  await expect(argRow(page, 4)).toContainText('Direction (string):');
  await expect(arg(page, 4)).toHaveAttribute('type', 'text');
  await expect(arg(page, 5)).toHaveValue(String(bars[1].default));
  // A range is a text box too, named as a range.
  await expect(argRow(page, 6)).toContainText('Iterations (range):');
  await expect(arg(page, 6)).toHaveAttribute('type', 'text');

  // Another effect takes the old one's arguments away.
  const other = effects.find((e) => e !== 'Bars' && e !== 'Stop Effects' && !e.startsWith('WLED'))!;
  const otherArgs = (await (await request.get(`/api/overlays/effects/${encodeURIComponent(other)}`)).json()).args ?? [];
  await sub.selectOption(other);
  await expect(page.locator(`#${TABLE} tr[id*=_arg_][id$=_row]`)).toHaveCount(3 + otherArgs.length);

  await arg(page, 1).fill('fpp-tests-matrix');
  await sub.selectOption('Bars');
  await arg(page, 5).fill('%1');
  const json = await toJSON(page);
  expect(json.args.slice(0, 5)).toEqual(['fpp-tests-matrix', 'Enabled', 'Bars', String(bars[0].default ?? ''), '%1']);
  expect(json.argTypes.slice(0, 3)).toEqual(['multistring', 'string', 'subcommand']);
});

test('a saved command opens with its values, placeholders included', async ({ page }) => {
  await editor(page);
  await page.evaluate(([table, select]) => {
    const w = window as any;
    w.PopulateExistingCommand({ command: 'Start Playlist', args: ['%1', '%2', 'true', 'false'] }, select, table, false, w.PrintArgsInputsForEditable);
  }, [TABLE, SELECT]);
  await expect(page.locator(`#${SELECT}`)).toHaveValue('Start Playlist');
  await expect(arg(page, 1)).toHaveValue('%1');
  await expect(arg(page, 2)).toHaveValue('%2');
  await expect(arg(page, 3)).toHaveValue('true');
  await expect(arg(page, 4)).toHaveValue('false');
  expect((await toJSON(page)).args).toEqual(['%1', '%2', 'true', 'false']);
});
