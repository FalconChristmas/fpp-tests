import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// Display Testing (testing.php): the custom pattern builders of the Channel
// Testing tab, and the Sequence tab's Play and Stop.  As in
// testing-page-patterns-and-strings.spec.ts the models, the running test and
// every command are answered here: nothing is lit and nothing is played.

test.skip(!container, 'seeds a sequence inside the run-web.sh container');

const SEQ = 'fpp-tests testing & play #1.fseq';
const SEQ_FILE = `${MEDIA}/sequences/${SEQ}`;
const MODELS = [
  { Name: 'fpp-tests-rgb', StartChannel: 1, ChannelCount: 30, StringCount: 1, ChannelCountPerNode: 3 },
  { Name: 'fpp-tests-rgbw', StartChannel: 101, ChannelCount: 40, StringCount: 1, ChannelCountPerNode: 4 },
];

test.beforeEach(() => putFile(SEQ_FILE, 'fpp-tests: listed, never played'));
test.afterEach(() => inPlayer('rm', '-f', SEQ_FILE));

type Command = { command: string; args: string[] };

async function open(page: Page, sequenceAnswer = 200) {
  const commands: Command[] = [];
  const sequence: string[] = [];
  await page.route((u) => u.pathname.endsWith('/api/models'), (route) => route.fulfill({ json: MODELS }));
  await page.route((u) => u.pathname.endsWith('/api/testmode'), (route) => route.fulfill({ json: { enabled: 0 } }));
  await page.route((u) => u.pathname.endsWith('/api/command'), async (route) => {
    commands.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, body: 'OK' });
  });
  await page.route((u) => u.pathname.includes('/api/sequence/'), async (route) => {
    // As sent, still encoded: the name must arrive as one path segment.
    sequence.push(`${route.request().method()} ${route.request().url().replace(/^.*\/api\/sequence\//, '')}`);
    await route.fulfill(sequenceAnswer === 200 ? { json: { status: 'OK' } } : { status: sequenceAnswer, body: 'no' });
  });
  await page.goto('/testing.php');
  await expect(page.locator('#modelName option', { hasText: 'fpp-tests-rgbw' })).toBeAttached({ timeout: 15_000 });
  return { commands, sequence };
}

const last = (c: Command[]) => c[c.length - 1];
async function check(page: Page, value: string) {
  await page.locator(`input[name=testModeMode][value="${value}"]`).evaluate((r: HTMLInputElement) => {
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function slider(page: Page, id: string, value: number) {
  await page.locator(`#${id}`).evaluate((s: HTMLInputElement, v) => {
    s.value = String(v);
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
const pick = (page: Page, id: string, hex: string) => page.locator(`#${id}`).evaluate((p: HTMLInputElement, v) => { p.value = v; }, hex);
const press = (page: Page, onclick: string) => page.locator(`[onclick="${onclick}"]`).evaluate((b: HTMLElement) => b.click());

test('the colour pickers build the custom chase and cycle patterns, one pixel a press', async ({ page }) => {
  const { commands } = await open(page);
  await page.locator('#modelName').selectOption({ label: 'fpp-tests-rgb' });
  await page.locator('#testModeEnabled').check();
  await check(page, 'RGBChase-RGBCustom');
  const chase = page.locator('#testModeRGBCustomPattern');
  const cycle = page.locator('#testModeRGBCycleCustomPattern');
  await press(page, 'ClearCustomChasePattern();');
  await press(page, 'ClearCustomPattern();');
  await expect(chase).toHaveValue('');

  await pick(page, 'customChasePatternColorPicker', '#12ab00');
  await press(page, 'AppendColorPickerToCustomChase();');
  await pick(page, 'customChasePatternColorPicker', '#0000ff');
  await press(page, 'AppendColorPickerToCustomChase();');
  await expect(chase).toHaveValue('12AB000000FF');
  await expect(cycle, 'the cycle pattern is its own').toHaveValue('');
  // Each press restarts the test with the pattern so far.
  await expect.poll(() => last(commands)?.args.slice(1)).toEqual(['Custom Chase', '1-30', '12AB000000FF']);

  await check(page, 'RGBCycle-RGBCustom');
  await pick(page, 'customPatternColorPicker', '#ffffff');
  await press(page, 'AppendColorPickerToCustom();');
  await expect(cycle).toHaveValue('FFFFFF');
  await expect(chase).toHaveValue('12AB000000FF');
  await expect.poll(() => last(commands).args.slice(1)).toEqual(['Custom Cycle', '1-30', 'FFFFFF']);

  await press(page, 'ClearCustomPattern();');
  await expect(cycle).toHaveValue('');
  await expect(chase).toHaveValue('12AB000000FF');
  await expect.poll(() => last(commands).args.slice(1)).toEqual(['Custom Cycle', '1-30', '']);
  await press(page, 'ClearCustomChasePattern();');
  await expect(chase).toHaveValue('');
});

test('Append Color To Custom Pattern adds the fill colour to both patterns', async ({ page }) => {
  const { commands } = await open(page);
  await page.locator('#modelName').selectOption({ label: 'fpp-tests-rgb' });
  await page.locator('#testModeEnabled').check();
  await press(page, 'ClearCustomChasePattern();');
  await press(page, 'ClearCustomPattern();');
  await slider(page, 'testModeColorR', 255);
  await slider(page, 'testModeColorG', 9);
  await slider(page, 'testModeColorB', 0);
  await check(page, 'RGBChase-RGBCustom');
  await page.locator('input[value="Append Color To Custom Pattern"]').evaluate((b: HTMLElement) => b.click());
  await expect(page.locator('#testModeRGBCustomPattern')).toHaveValue('FF0900');
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('FF0900');
  await expect.poll(() => last(commands).args.slice(1)).toEqual(['Custom Chase', '1-30', 'FF0900']);
});

test('on a four-channel model every colour added is four channels wide', async ({ page }) => {
  const { commands } = await open(page);
  await page.locator('#modelName').selectOption({ label: 'fpp-tests-rgbw' });
  await page.locator('#testModeEnabled').check();
  await press(page, 'ClearCustomChasePattern();');
  await press(page, 'ClearCustomPattern();');
  await check(page, 'RGBChase-RGBCustom');

  // The picker has no white: 00 keeps the next pixel aligned.
  await pick(page, 'customChasePatternColorPicker', '#ff0000');
  await press(page, 'AppendColorPickerToCustomChase();');
  await expect(page.locator('#testModeRGBCustomPattern')).toHaveValue('FF000000');
  await pick(page, 'customPatternColorPicker', '#00ff00');
  await press(page, 'AppendColorPickerToCustom();');
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('00FF0000');

  // The fill colour brings its white.
  await slider(page, 'testModeColorR', 1);
  await slider(page, 'testModeColorG', 2);
  await slider(page, 'testModeColorB', 3);
  await slider(page, 'testModeColorW', 200);
  await page.locator('input[value="Append Color To Custom Pattern"]').evaluate((b: HTMLElement) => b.click());
  await expect(page.locator('#testModeRGBCustomPattern')).toHaveValue('FF000000010203C8');
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('00FF0000010203C8');
  await expect.poll(() => last(commands).args.slice(1)).toEqual(['Custom Chase', '101-140', 'FF000000010203C8', '4']);
});

test('the Sequence tab plays the chosen sequence from the second given, and stops it', async ({ page }) => {
  const { sequence } = await open(page);
  await page.locator('#tab-sequence-tab').click();
  await expect(page.locator('#playSequence')).toBeVisible();
  await page.locator('#selSequence').selectOption(SEQ);
  await page.locator('#startSecond').fill('42');
  await page.locator('#playSequence').click();
  await expect.poll(() => sequence).toEqual([`POST ${encodeURIComponent(SEQ)}/start/42`]);
  await expect(page.locator('.jGrowl-notification', { hasText: `Started sequence ${SEQ}` })).toBeVisible();

  await page.locator('#stopSequence').click();
  await expect.poll(() => sequence[1]).toBe('POST current/stop');
  await expect(page.locator('#dialogOKPopup')).toBeHidden();
});

test('a sequence fppd will not start or stop is reported', async ({ page }) => {
  await open(page, 500);
  await page.locator('#tab-sequence-tab').click();
  await page.locator('#selSequence').selectOption(SEQ);
  const dialog = page.locator('#dialogOKPopup');
  await page.locator('#playSequence').click();
  await expect(dialog.locator('.modal-title')).toHaveText('Failed to start sequence');
  await dialog.locator('button', { hasText: /^(OK|Close)$/ }).first().click();
  await expect(dialog).toBeHidden();
  await page.locator('#stopSequence').click();
  await expect(dialog.locator('.modal-title')).toHaveText('Failed to stop sequence');
});

test('Play with no start time asks for the start of the sequence', async ({ page }) => {
  test.fail(true, 'an empty Start Time is put in the URL as it is: ".../start/", which is no route (FUTURE.md)');
  const { sequence } = await open(page);
  await page.locator('#tab-sequence-tab').click();
  await page.locator('#selSequence').selectOption(SEQ);
  await page.locator('#startSecond').fill('');
  await page.locator('#playSequence').click();
  await expect.poll(() => sequence).toHaveLength(1);
  expect(sequence[0]).toBe(`POST ${encodeURIComponent(SEQ)}/start/0`);
});
