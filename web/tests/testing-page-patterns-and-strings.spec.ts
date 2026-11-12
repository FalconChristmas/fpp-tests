import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Display Testing (testing.php), Channel Testing tab: what the page asks fppd
// for.  The models, the running test and the command endpoint are all
// answered here, so no test pattern reaches the player; every "Test Start"
// the page posts is kept and its arguments are the assertion:
//   [cycle ms, pattern, "<start>-<end>", pattern arguments...]

const MODELS = [
  { Name: 'fpp-tests-strings', StartChannel: 101, ChannelCount: 120, StringCount: 4, ChannelCountPerNode: 3 },
  { Name: 'fpp-tests-rgbw', StartChannel: 1001, ChannelCount: 40, StringCount: 1, ChannelCountPerNode: 4 },
  { Name: 'fpp-tests-mono', StartChannel: 2001, ChannelCount: 10, StringCount: 1, ChannelCountPerNode: 1 },
];

type Command = { command: string; multisyncCommand: boolean; multisyncHosts: string; args: string[] };

async function open(page: Page, running: object = { enabled: 0 }) {
  const sent: Command[] = [];
  await page.route((u) => u.pathname.endsWith('/api/models'), (route) => route.fulfill({ json: MODELS }));
  await page.route((u) => u.pathname.endsWith('/api/testmode'), (route) => route.fulfill({ json: running }));
  await page.route((u) => u.pathname.endsWith('/api/command'), async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, body: 'OK' });
  });
  await page.goto('/testing.php');
  await expect(page.locator('#modelName option', { hasText: 'fpp-tests-mono' })).toBeAttached({ timeout: 15_000 });
  return sent;
}

const model = (page: Page, name: string) => page.locator('#modelName').selectOption({ label: name });
const last = (sent: Command[]) => sent[sent.length - 1];
// A mode radio, wherever on the tab it is: checked as a click on it would.
async function mode(page: Page, value: string) {
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
const range = async (page: Page) =>
  `${await page.locator('#testModeStartChannel').inputValue()}-${await page.locator('#testModeEndChannel').inputValue()}`;

test('a model with several strings is tested by string, and the range follows the string buttons', async ({ page }) => {
  const sent = await open(page);
  await model(page, 'fpp-tests-strings');
  // Four strings of 30 channels from channel 101.
  await expect(page.locator('#startString')).toBeVisible();
  expect(await range(page)).toBe('101-220');
  await expect(page.locator('#startString')).toHaveValue('1');
  await expect(page.locator('#endString')).toHaveValue('4');
  await expect(page.locator('#channelIncrement')).toHaveValue('30');
  expect(sent, 'nothing is sent while test mode is off').toEqual([]);

  await page.locator('#testModeEnabled').check();
  await expect.poll(() => last(sent)?.args[2]).toBe('101-220');

  const startUp = page.locator('input[onclick="AdjustStartString(1);"]');
  const startDown = page.locator('input[onclick="AdjustStartString(-1);"]');
  const endUp = page.locator('input[onclick="AdjustEndString(1);"]');
  const endDown = page.locator('input[onclick="AdjustEndString(-1);"]');

  await startUp.click();                      // strings 2-4
  expect(await range(page)).toBe('131-220');
  await expect.poll(() => last(sent).args[2]).toBe('131-220');
  await endDown.click();                      // strings 2-3
  expect(await range(page)).toBe('131-190');
  await expect.poll(() => last(sent).args[2]).toBe('131-190');

  // The start pushed past the end takes the end with it, and stops at the last string.
  await startUp.click(); await startUp.click(); await startUp.click();
  await expect(page.locator('#startString')).toHaveValue('4');
  await expect(page.locator('#endString')).toHaveValue('4');
  expect(await range(page)).toBe('191-220');
  await endUp.click();
  await expect(page.locator('#endString')).toHaveValue('4');

  // The end pulled below the start takes the start with it, and stops at the first.
  await endDown.click();
  await expect(page.locator('#startString')).toHaveValue('3');
  expect(await range(page)).toBe('161-190');
  await endDown.click(); await endDown.click(); await endDown.click(); await startDown.click();
  await expect(page.locator('#startString')).toHaveValue('1');
  await expect(page.locator('#endString')).toHaveValue('1');
  expect(await range(page)).toBe('101-130');

  // Typed string numbers.
  await page.locator('#endString').fill('3');
  await page.locator('#endString').blur();
  expect(await range(page)).toBe('101-190');
  await expect.poll(() => last(sent).args[2]).toBe('101-190');
  expect(sent.every((c) => c.command === 'Test Start')).toBe(true);

  // A one-string model has no string range.
  await model(page, 'fpp-tests-rgbw');
  await expect(page.locator('#startString')).toBeHidden();
  expect(await range(page)).toBe('1001-1040');
  await expect(page.locator('#channelIncrement')).toHaveValue('4');
});

test('each pattern on the tab asks fppd for its own test', async ({ page }) => {
  const sent = await open(page);
  await model(page, 'fpp-tests-strings');
  await page.locator('#testModeEnabled').check();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const cycle = await page.locator('#testModeCycleMSText').innerText();

  const steps: Record<string, string> = {
    RGB: 'R-G-B', RGBA: 'R-G-B-All', RGBN: 'R-G-B-None', RGBAN: 'R-G-B-All-None',
    RGBW: 'R-G-B-W', RGBWA: 'R-G-B-W-All', RGBWN: 'R-G-B-W-None', RGBWAN: 'R-G-B-W-All-None',
  };
  for (const [kind, pattern] of [['RGBChase', 'RGB Chase'], ['RGBCycle', 'RGB Cycle']]) {
    for (const [suffix, step] of Object.entries(steps)) {
      const n = sent.length;
      await mode(page, `${kind}-${suffix}`);
      await expect.poll(() => sent.length, { message: `${kind}-${suffix} sent nothing` }).toBeGreaterThan(n);
      expect(last(sent), `${kind}-${suffix}`).toEqual({
        command: 'Test Start', multisyncCommand: false, multisyncHosts: '', args: [cycle, pattern, '101-220', step],
      });
    }
  }

  await page.locator('#testModeRGBCustomPattern').fill('FF000000FF00');
  await mode(page, 'RGBChase-RGBCustom');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Custom Chase', '101-220', 'FF000000FF00']);
  await page.locator('#testModeRGBCycleCustomPattern').fill('0000FF');
  await mode(page, 'RGBCycle-RGBCustom');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Custom Cycle', '101-220', '0000FF']);

  await slider(page, 'testModeColorS', 200);
  await page.locator('#testModeChaseSize').evaluate((s: HTMLSelectElement) => { s.value = '5'; });
  await mode(page, 'SingleChase');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Single Channel Chase', '101-220', '200', '5']);
  await mode(page, 'SingleFill');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Single Channel Fill', '101-220', '200']);

  await slider(page, 'testModeColorR', 18);
  await slider(page, 'testModeColorG', 0);
  await slider(page, 'testModeColorB', 255);
  await mode(page, 'RGBFill');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'RGB Single Color', '101-220', '#1200ff']);

  // Multisync is carried on the command.
  await page.locator('#multisyncEnabled').check();
  await expect.poll(() => last(sent).multisyncCommand).toBe(true);
});

test('a four-channel model adds the white channel to a fill and the stride to a custom pattern', async ({ page }) => {
  const sent = await open(page);
  await model(page, 'fpp-tests-rgbw');
  await expect(page.locator('#channelsPerPixel')).toHaveValue('4');
  await page.locator('#testModeEnabled').check();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const cycle = await page.locator('#testModeCycleMSText').innerText();

  await slider(page, 'testModeColorR', 1);
  await slider(page, 'testModeColorG', 2);
  await slider(page, 'testModeColorB', 3);
  await mode(page, 'RGBFill');
  // White is sent even at 0, so the fill keeps a four-channel stride.
  await expect.poll(() => last(sent).args).toEqual([cycle, 'RGB Single Color', '1001-1040', '#01020300']);
  await slider(page, 'testModeColorW', 128);
  await expect.poll(() => last(sent).args).toEqual([cycle, 'RGB Single Color', '1001-1040', '#01020380']);

  await page.locator('#testModeRGBCustomPattern').fill('FF00000000FF0000');
  await mode(page, 'RGBChase-RGBCustom');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Custom Chase', '1001-1040', 'FF00000000FF0000', '4']);
  await page.locator('#testModeRGBCycleCustomPattern').fill('000000FF');
  await mode(page, 'RGBCycle-RGBCustom');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'Custom Cycle', '1001-1040', '000000FF', '4']);

  // Back on a three-channel model the white slider is off and no longer sent.
  await model(page, 'fpp-tests-strings');
  await expect(page.locator('#testModeColorW')).toBeDisabled();
  await mode(page, 'RGBFill');
  await expect.poll(() => last(sent).args).toEqual([cycle, 'RGB Single Color', '101-220', '#010203']);
});

test('the notice under Channels per Pixel says when one stride cannot fit', async ({ page }) => {
  await open(page);
  const notice = page.locator('#strideNotice');
  await model(page, 'fpp-tests-strings');
  await expect(notice).toBeHidden();

  await model(page, 'fpp-tests-mono');
  await expect(page.locator('#channelsPerPixel')).toHaveValue('1');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('The RGB test patterns always write 3 channels per pixel.');
  await expect(notice).not.toContainText('Models in this range');

  // The whole range holds models of 1, 3 and 4 channels a pixel.
  await page.locator('#modelName').selectOption({ label: '-- All Channels --' });
  await expect(page.locator('#channelsPerPixel')).toHaveValue('3');
  await expect(notice).toContainText('Models in this range use 1 and 3 and 4 channels per pixel.');
  await expect(notice).not.toContainText('The RGB test patterns always write');
});

test('a range that is not a range is tested as the nearest one that is', async ({ page }) => {
  const sent = await open(page);
  await page.locator('#testModeEnabled').check();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  const set = async (start: string, end: string) => {
    await page.locator('#testModeStartChannel').evaluate((e: HTMLInputElement, v) => { e.value = v; }, start);
    await page.locator('#testModeEndChannel').evaluate((e: HTMLInputElement, v) => { e.value = v; }, end);
    const n = sent.length;
    await mode(page, 'SingleFill');
    await expect.poll(() => sent.length).toBeGreaterThan(n);
    return last(sent).args[2];
  };
  expect(await set('0', '')).toBe('1-8388608');       // no start: from 1; no end: to the last channel
  expect(await set('500', '20')).toBe('500-500');     // an end before the start
  expect(await set('-5', '9000000')).toBe('1-8388608');
});

test('a test that is already running is shown as it runs', async ({ page }) => {
  await open(page, { enabled: 1, mode: 'RGBFill', color1: 10, color2: 20, color3: 30 });
  await expect(page.locator('#testModeEnabled')).toBeChecked();
  await expect(page.locator('input[name=testModeMode][value=RGBFill]')).toBeChecked();
  await expect(page.locator('#testModeColorRText')).toHaveText('10');
  await expect(page.locator('#testModeColorGText')).toHaveText('20');
  await expect(page.locator('#testModeColorBText')).toHaveText('30');
  // No cycle time in the answer: one second.
  await expect(page.locator('#testModeCycleMSText')).toHaveText('1000');

  await open(page, { enabled: 1, cycleMS: 400, mode: 'SingleChase', chaseSize: 4, chaseValue: 77 });
  await expect(page.locator('input[name=testModeMode][value=SingleChase]')).toBeChecked();
  await expect(page.locator('#testModeChaseSize')).toHaveValue('4');
  await expect(page.locator('#testModeColorSText')).toHaveText('77');
  await expect(page.locator('#testModeCycleMSText')).toHaveText('400');

  await open(page, { enabled: 1, cycleMS: 400, mode: 'RGBChase', subMode: 'RGBChase-RGBCustom', colorPattern: 'FF0000' });
  await expect(page.locator('input[name=testModeMode][value="RGBChase-RGBCustom"]')).toBeChecked();
  await expect(page.locator('#testModeRGBCustomPattern')).toHaveValue('FF0000');

  const sent = await open(page, { enabled: 1, cycleMS: 400, mode: 'RGBCycle', subMode: 'RGBCycle-RGBCustom', colorPattern: '00FF00' });
  await expect(page.locator('input[name=testModeMode][value="RGBCycle-RGBCustom"]')).toBeChecked();
  await expect(page.locator('#testModeRGBCycleCustomPattern')).toHaveValue('00FF00');

  // Unticking stops it.
  await page.locator('#testModeEnabled').uncheck();
  await expect.poll(() => last(sent)).toEqual({ command: 'Test Stop', multisyncCommand: false, multisyncHosts: '', args: [] });
});

test('a test fppd refuses to start or stop is reported', async ({ page }) => {
  // A test the Channel Fader tab started: this tab says so, with a Stop Test
  // button of its own.
  await page.addInitScript(() => { try { sessionStorage.setItem('fppTestOwner', 'dmx'); } catch { /* blocked */ } });
  await open(page, { enabled: 1, mode: 'SingleFill' });
  // From here on fppd refuses every command.
  await page.route((u) => u.pathname.endsWith('/api/command'), (route) => route.fulfill({ status: 500, body: 'refused' }));
  const dialog = page.locator('#dialogOKPopup');
  const takeover = page.locator('#channelTestTakeover');
  await expect(takeover).toBeVisible();
  await takeover.locator('button', { hasText: 'Stop Test' }).click();
  await expect(dialog.locator('.modal-title')).toHaveText('Failed to stop Test Mode');
  // It is still shown as running.
  await expect(takeover).toBeVisible();
  await dialog.locator('button', { hasText: /^(OK|Close)$/ }).first().click();
  await expect(dialog).toBeHidden();

  // Taking it over here fails the same way.
  await page.locator('#testModeEnabled').check();
  await expect(dialog.locator('.modal-title')).toHaveText('Failed to set Test Mode');
});
