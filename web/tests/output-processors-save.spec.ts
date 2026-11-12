import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// What the Output Processors page saves (SetOutputProcessors()): fppd applies
// these to every frame it outputs, so a processor the page draws and saves
// back must come back as it was, a new one must be saved with what its row
// shows, and a table the page refuses must leave the saved one alone.

test.skip(!container, 'seeds outputprocessors.json and the overlay model inside the run-web.sh container');

const FILE = `${MEDIA}/config/outputprocessors.json`;
const MODEL = 'fpp-tests-matrix';
const NO_MODEL = '<Use Start Channel>';

// One of every type fppd has (OutputProcessor.cpp), each away from the
// page's defaults.
const ALL = [
  { type: 'Remap', active: 1, description: "Tom's \"arch\" <remap>", model: NO_MODEL, source: 1, destination: 301, count: 30, loops: 2, reverse: 2 },
  { type: 'Brightness', active: 0, description: 'dim', model: MODEL, start: 4, count: 60, brightness: 40, gamma: 2.2 },
  { type: 'Set Value', active: 1, description: 'set', model: NO_MODEL, start: 10, count: 3, value: 128 },
  { type: 'Clamp Value', active: 1, description: 'clamp', model: NO_MODEL, start: 20, count: 9, value: 200 },
  { type: 'Scale Value', active: 1, description: 'scale', model: NO_MODEL, start: 30, count: 6, scale: 0.25 },
  { type: 'Hold Value', active: 1, description: 'hold', model: NO_MODEL, start: 40, count: 12 },
  { type: 'Reorder Colors', active: 1, description: 'reorder', model: NO_MODEL, start: 50, count: 10, colorOrder: 321 },
  { type: 'Three to Four', active: 1, description: 'rgbw', model: NO_MODEL, start: 60, count: 10, colorOrder: 4123, algorithm: 2 },
  { type: 'Override Zero', active: 1, description: 'zero', model: NO_MODEL, start: 70, count: 3, value: 5 },
  // Fold has no model.
  { type: 'Fold', active: 1, description: 'fold', source: 80, count: 30, node: 1 },
];

let before: string | null = null;
let errors: string[] = [];
test.beforeEach(({ page }) => {
  before = exists(FILE) ? readFile(FILE) : null;
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => {
  if (before === null) inPlayer('rm', '-f', FILE);
  else putFile(FILE, before);
  expect(errors, 'the page threw').toEqual([]);
});

const saved = async (request: APIRequestContext) =>
  (await (await request.get('/api/channel/output/processors')).json()).outputProcessors;
const rows = (page: Page) => page.locator('#outputProcessorsBody > tr');

async function open(page: Page, count: number) {
  await page.goto('/outputprocessors.php');
  await expect(rows(page)).toHaveCount(count, { timeout: 15_000 });
}
async function save(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('api/channel/output/processors'));
  await page.locator('input[type=button][value=Save]').click();
  expect((await posted).ok()).toBe(true);
  await expect(page.locator('.jGrowl-message', { hasText: 'Output Processors Table saved' })).toBeVisible();
}

test('every type of processor is drawn and saved back as it was', async ({ page, request }) => {
  putFile(FILE, JSON.stringify({ outputProcessors: ALL }, null, 4));
  await open(page, ALL.length);
  await expect(rows(page).nth(0).locator('input.description')).toHaveValue(ALL[0].description);
  await expect(rows(page).nth(1).locator('select.model')).toHaveValue(MODEL);
  await expect(rows(page).nth(1).locator('input.active')).not.toBeChecked();
  await expect(rows(page).nth(9).locator('select.model')).toHaveCount(0);
  await save(page);
  expect(await saved(request)).toEqual(ALL);
});

test('a new row of each type is saved with what its row shows', async ({ page, request }) => {
  putFile(FILE, JSON.stringify({ outputProcessors: [] }));
  await open(page, 0);
  const types = ALL.map((p) => p.type);
  for (const type of types) {
    await page.locator('button', { hasText: 'Add' }).first().click();
    const row = rows(page).last();
    await row.locator('select.type').selectOption(type);
    await expect(row.locator('td:nth-child(3)')).toHaveText(type);
    await row.locator('input.description').fill(`new ${type}`);
  }
  // Change a couple of the defaults as someone would.
  const remap = rows(page).nth(0);
  await remap.locator('input.destination').fill('151');
  await remap.locator('input.count').fill('150');
  await rows(page).nth(1).locator('select.model').selectOption(MODEL);
  await rows(page).nth(1).locator('input.brightness').fill('75');
  await save(page);

  const out = await saved(request);
  expect(out.map((p: any) => p.type)).toEqual(types);
  expect(out.map((p: any) => p.description)).toEqual(types.map((t) => `new ${t}`));
  const defaults = out.map(({ description, ...rest }: any) => rest);
  expect(defaults).toEqual([
    { type: 'Remap', active: 1, model: NO_MODEL, source: 1, destination: 151, count: 150, loops: 1, reverse: 0 },
    { type: 'Brightness', active: 1, model: MODEL, start: 1, count: 1, brightness: 75, gamma: 1 },
    { type: 'Set Value', active: 1, model: NO_MODEL, start: 1, count: 1, value: 255 },
    { type: 'Clamp Value', active: 1, model: NO_MODEL, start: 1, count: 1, value: 255 },
    { type: 'Scale Value', active: 1, model: NO_MODEL, start: 1, count: 1, scale: 1 },
    { type: 'Hold Value', active: 1, model: NO_MODEL, start: 1, count: 1 },
    { type: 'Reorder Colors', active: 1, model: NO_MODEL, start: 1, count: 1, colorOrder: 132 },
    { type: 'Three to Four', active: 1, model: NO_MODEL, start: 1, count: 1, colorOrder: 1234, algorithm: 1 },
    { type: 'Override Zero', active: 1, model: NO_MODEL, start: 1, count: 1, value: 255 },
    { type: 'Fold', active: 1, source: 1, count: 1, node: 0 },
  ]);
});

for (const [what, fix] of [
  ['a row with no type chosen', async (page: Page) => {
    await page.locator('button', { hasText: 'Add' }).first().click();
  }],
  ['a remap of no channels', async (page: Page) => {
    await rows(page).nth(0).locator('input.count').fill('0');
  }],
  ['a processor starting at channel 0', async (page: Page) => {
    await rows(page).nth(2).locator('input.start').fill('0');
  }],
  ['a fold from no channel', async (page: Page) => {
    await rows(page).nth(9).locator('input.source').fill('');
  }],
] as const) {
  test(`${what} is refused, and nothing is saved`, async ({ page, request }) => {
    putFile(FILE, JSON.stringify({ outputProcessors: ALL }, null, 4));
    await open(page, ALL.length);
    await fix(page);
    // The other rows are fine: the save still has to be refused as a whole.
    await rows(page).nth(3).locator('input.description').fill('changed');
    const said: string[] = [];
    page.on('dialog', (d) => { said.push(d.message()); d.accept(); });
    let posted = false;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('output/processors')) posted = true; });
    await page.locator('input[type=button][value=Save]').click();
    await expect.poll(async () => said.length + await page.locator('.modal.show, .ui-dialog:visible').count()).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(posted, 'the table was posted').toBe(false);
    expect(await saved(request)).toEqual(ALL);
  });
}

// The model list is escaped when written into each row's select, so a model
// named with an apostrophe keeps its whole name, and a save writes that.
test("a processor on a model named with an apostrophe keeps its model when saved", async ({ page, request }) => {
  const name = "Tom's tree";
  await page.route((u) => u.pathname.endsWith('/api/models') && u.search.includes('simple'), (r) =>
    r.fulfill({ json: [MODEL, name] }));
  const p = [{ type: 'Brightness', active: 1, description: 'tree', model: name, start: 1, count: 30, brightness: 50, gamma: 1 },
    { type: 'Brightness', active: 1, description: 'control', model: MODEL, start: 1, count: 30, brightness: 50, gamma: 1 }];
  putFile(FILE, JSON.stringify({ outputProcessors: p }));
  await open(page, 2);
  await expect(rows(page).nth(1).locator('select.model'), 'the control').toHaveValue(MODEL);
  await expect(rows(page).nth(0).locator('select.model')).toHaveValue(name, { timeout: 2000 });
  await save(page);
  expect((await saved(request))[0].model).toBe(name);
});
