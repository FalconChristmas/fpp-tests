import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';

// The preset list of a Control Channel output (co-other-modules.php).  The
// page reads the player's commandPresets.json when it is drawn.

test.skip(!container, 'changes the player\'s command presets');

const PRESET = 'fpp-tests-lights-on';
const preset = {
  name: PRESET, command: 'Set Variable', args: ['fppTestsControl', 'Value', PRESET, '1', '0', '100', ''],
  multisyncCommand: false, multisyncHosts: '', presetSlot: 0,
};

let presetsBefore: string | null = null;
let othersBefore: string | null = null;
async function putConfig(request: APIRequestContext, file: string, body: string) {
  const r = await request.post(`/api/configfile/${file}`, { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}
test.beforeEach(async ({ request }) => {
  const p = await request.get('/api/configfile/commandPresets.json');
  presetsBefore = p.ok() ? await p.text() : null;
  const o = await request.get('/api/channel/output/co-other');
  othersBefore = o.ok() ? await o.text() : null;
});
test.afterEach(async ({ request }) => {
  await putConfig(request, 'commandPresets.json', presetsBefore ?? '{"commands": []}');
  await request.post('/api/channel/output/co-other', { data: Buffer.from(othersBefore ?? '{"channelOutputs": []}') });
});

test('a Control Channel preset list is offered and selected by the preset\'s name', async ({ page, request }) => {
  // Regression: 3e5cb0a34.  The list took each option from the preset's
  // command ("Set Variable") instead of its name, so every preset showed as
  // the same command, none could be told apart, and the one saved with the
  // output was never the selected one.
  await putConfig(request, 'commandPresets.json', JSON.stringify({ commands: [preset] }));
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'ControlChannel', enabled: 0, startChannel: 40, channelCount: 1, values: [{ value: 7, preset: PRESET }],
  }] } });
  expect(r.ok(), await r.text()).toBe(true);

  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-ControlSignal-tab').click();
  const select = page.locator('#tab-other-ControlSignal .presetRow #presetName');
  await expect(select.locator('option')).toHaveText(['-- Select Command Preset --', PRESET]);
  await expect(select.locator('option').nth(1)).toHaveAttribute('value', PRESET);
  await expect(select).toHaveValue(PRESET);

  // What the output keeps is the name fppd looks the preset up by.
  await page.locator('#tab-other-ControlSignal input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const c = (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
    return c.find((o) => o.type === 'ControlChannel')?.values?.[0];
  }, { timeout: 15_000 }).toEqual({ preset: PRESET, value: 7 });
});

test('a preset name with quotes and markup is offered, selected and saved as written', async ({ page, request }) => {
  // Regression: 54c1cd6b6.  CreatePesetRow() wrote each preset's name into the option's
  // value='...' and its text as markup: a name with a quote ended the value
  // early, so the output saved a cut-off name fppd could not find, and markup
  // in a name ran when the tab was drawn.
  const name = `fpp-tests it's <img src=x onerror="window.fppTestsRan=1"> on`;
  await putConfig(request, 'commandPresets.json', JSON.stringify({ commands: [{ ...preset, name }] }));
  const r = await request.post('/api/channel/output/co-other', { data: { channelOutputs: [{
    type: 'ControlChannel', enabled: 0, startChannel: 40, channelCount: 1, values: [{ value: 7, preset: name }],
  }] } });
  expect(r.ok(), await r.text()).toBe(true);

  page.on('dialog', (d) => d.accept());
  await page.goto('/channeloutputs.php');
  await expect(page.locator('#addOutputCategoryMenu')).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-other-ControlSignal-tab').click();
  const select = page.locator('#tab-other-ControlSignal .presetRow #presetName');
  await expect(select.locator('option')).toHaveText(['-- Select Command Preset --', name]);
  await expect(select.locator('option').nth(1)).toHaveAttribute('value', name);
  await expect(select).toHaveValue(name);
  await expect(page.locator('#tab-other-ControlSignal .presetRow img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fppTestsRan)).toBeUndefined();

  await page.locator('#tab-other-ControlSignal input[value="Save"]:not(.Zebra_Pin_Clone *)').click();
  await expect.poll(async () => {
    const c = (await (await request.get('/api/channel/output/co-other')).json()).channelOutputs as any[];
    return c.find((o) => o.type === 'ControlChannel')?.values?.[0];
  }, { timeout: 15_000 }).toEqual({ preset: name, value: 7 });
});
