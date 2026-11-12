import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Display Testing (testing.php), Channel Fader tab: one fader per channel,
// sent to fppd as a "Custom Chase" whose pattern is the faders' values, one
// byte a channel, over exactly the channels shown.  As in the other
// testing-page specs the models, the running test and every command are
// answered here, so nothing is lit; the commands the page posts are the
// assertion.

const MODELS = [
  { Name: 'fpp-tests-par <b>', StartChannel: 21, ChannelCount: 4, StringCount: 1, ChannelCountPerNode: 1 },
  { Name: 'fpp-tests-mover', StartChannel: 25, ChannelCount: 20, StringCount: 1, ChannelCountPerNode: 1 },
  { Name: 'fpp-tests-matrix', StartChannel: 1001, ChannelCount: 3000, StringCount: 10, ChannelCountPerNode: 3 },
];
const STATIC = '86400000';   // the cycle time that keeps a fader pattern still

type Command = { command: string; multisyncCommand: boolean; multisyncHosts: string; args: string[] };

async function open(page: Page) {
  const sent: Command[] = [];
  await page.route((u) => u.pathname.endsWith('/api/models'), (route) => route.fulfill({ json: MODELS }));
  await page.route((u) => u.pathname.endsWith('/api/testmode'), (route) => route.fulfill({ json: { enabled: 0 } }));
  await page.route((u) => u.pathname.endsWith('/api/command'), async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, body: 'OK' });
  });
  await page.goto('/testing.php');
  await expect(page.locator('#dmxModelName option', { hasText: 'fpp-tests-mover' })).toBeAttached({ timeout: 15_000 });
  await page.locator('#tab-dmx-tab').click();
  await expect(page.locator('#dmxTestEnabled')).toBeVisible();
  return sent;
}

const last = (sent: Command[]) => sent[sent.length - 1];
const boxes = (page: Page) => page.locator('#dmxSliderTabsContent .dmxChannelBox');
// A fader's number box, typed into as a user would.
async function setValue(page: Page, idx: number, value: string) {
  await page.locator(`.dmxValueInput[data-idx="${idx}"]`).evaluate((e: HTMLInputElement, v) => {
    e.value = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function setField(page: Page, id: string, value: string) {
  await page.locator(`#${id}`).evaluate((e: HTMLInputElement, v) => {
    e.value = v;
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('a model sets the faders to its channels, and only fixture-sized models are offered', async ({ page }) => {
  const sent = await open(page);
  const offered = await page.locator('#dmxModelName option').allTextContents();
  expect(offered.some((t) => t.includes('fpp-tests-mover (Ch 25, 20ch)'))).toBe(true);
  expect(offered.some((t) => t.includes('fpp-tests-matrix')), 'a 3000-channel model on the fader list').toBe(false);

  await page.locator('#dmxModelName').selectOption({ label: 'fpp-tests-mover (Ch 25, 20ch)' });
  await expect(page.locator('#dmxStartChannel')).toHaveValue('25');
  await expect(page.locator('#dmxChannelCount')).toHaveValue('20');
  await expect(boxes(page)).toHaveCount(20);
  // Sixteen faders a tab.
  await expect(page.locator('#dmxSliderTabsNav .nav-link')).toHaveText(['Ch 25-40', 'Ch 41-44']);
  await expect(boxes(page).first()).toContainText('fpp-tests-mover');
  await expect(boxes(page).first()).toContainText('Ch 1 / 20');
  expect(sent, 'nothing is sent until the tab\'s test is enabled').toEqual([]);

  // A range typed by hand lets go of the model, and marks the fixtures in it.
  await setField(page, 'dmxStartChannel', '23');
  await setField(page, 'dmxChannelCount', '4');
  await expect(page.locator('#dmxModelName')).toHaveValue('');
  await expect(boxes(page)).toHaveCount(4);
  // Channels 23 and 24 are the par's last two, 25 and 26 the mover's first two;
  // the par's name is shown as text.
  await expect(boxes(page).nth(0)).toContainText('fpp-tests-par <b>');
  await expect(boxes(page).nth(0)).toContainText('Ch 3 / 4');
  await expect(boxes(page).nth(2)).toContainText('fpp-tests-mover');
  await expect(boxes(page).nth(2)).toContainText('Ch 1 / 20');
  expect(await page.locator('#dmxSliderTabsContent .dmxFixtureName').first().innerHTML(), 'the model name was read as HTML').toBe('fpp-tests-par &lt;b&gt;');
});

test('the faders are sent as one byte a channel over the channels shown', async ({ page }) => {
  const sent = await open(page);
  await setField(page, 'dmxStartChannel', '101');
  await setField(page, 'dmxChannelCount', '5');
  await page.locator('#dmxTestEnabled').check();
  await expect.poll(() => last(sent)).toEqual({
    command: 'Test Start', multisyncCommand: false, multisyncHosts: '', args: [STATIC, 'Custom Chase', '101-105', '0000000000'],
  });

  await setValue(page, 0, '255');
  await setValue(page, 3, '16');
  await expect.poll(() => last(sent).args[3]).toBe('FF00001000');
  // The slider follows its number box.
  await expect(page.locator('.dmxSlider[data-idx="3"]')).toHaveValue('16');

  // A value out of range is the nearest one in it; one that is no number is 0.
  await setValue(page, 1, '300');
  await setValue(page, 2, '-3');
  await setValue(page, 4, 'x');
  await expect(page.locator('.dmxValueInput[data-idx="1"]')).toHaveValue('255');
  await expect(page.locator('.dmxValueInput[data-idx="2"]')).toHaveValue('0');
  await expect.poll(() => last(sent).args[3]).toBe('FFFF001000');

  // More channels keep the values already set; fewer drop the ones cut off.
  await setField(page, 'dmxChannelCount', '7');
  await expect.poll(() => last(sent).args.slice(2)).toEqual(['101-107', 'FFFF0010000000']);
  await setField(page, 'dmxChannelCount', '2');
  await expect.poll(() => last(sent).args.slice(2)).toEqual(['101-102', 'FFFF']);

  await page.locator('[onclick="DMXSetAll(128);"]').click();
  await expect.poll(() => last(sent).args[3]).toBe('8080');
  await page.locator('[onclick="DMXSetAll(255);"]').click();
  await expect.poll(() => last(sent).args[3]).toBe('FFFF');
  await page.locator('[onclick="DMXSetAll(0);"]').click();
  await expect.poll(() => last(sent).args[3]).toBe('0000');

  await page.locator('#dmxMultisyncEnabled').check();
  await expect.poll(() => last(sent).multisyncCommand).toBe(true);

  await page.locator('#dmxTestEnabled').uncheck();
  await expect.poll(() => last(sent)).toEqual({ command: 'Test Stop', multisyncCommand: true, multisyncHosts: '', args: [] });
});

test('a range that is not one is brought back inside the channels there are', async ({ page }) => {
  await open(page);
  await setField(page, 'dmxStartChannel', '0');
  await setField(page, 'dmxChannelCount', '9999');
  await expect(page.locator('#dmxStartChannel')).toHaveValue('1');
  await expect(page.locator('#dmxChannelCount')).toHaveValue('512');
  await expect(boxes(page)).toHaveCount(512);

  await setField(page, 'dmxChannelCount', '0');
  await expect(page.locator('#dmxChannelCount')).toHaveValue('1');
  // The last channel fppd has: no fader past it.
  await setField(page, 'dmxChannelCount', '8');
  await setField(page, 'dmxStartChannel', '8388605');
  await expect(page.locator('#dmxChannelCount')).toHaveValue('4');
  await expect(page.locator('#dmxSliderTabsNav .nav-link')).toHaveText(['Ch 8388605-8388608']);
});

test('the sine wave enables the test, moves every fader, and stops when told to', async ({ page }) => {
  const sent = await open(page);
  await setField(page, 'dmxStartChannel', '201');
  await setField(page, 'dmxChannelCount', '6');
  await expect(page.locator('#dmxSineStopBtn')).toBeDisabled();
  await page.locator('#dmxSineStartBtn').click();
  await expect(page.locator('#dmxTestEnabled')).toBeChecked();
  await expect(page.locator('#dmxSineStartBtn')).toBeDisabled();
  await expect.poll(() => sent.length, { timeout: 5_000 }).toBeGreaterThan(5);
  for (const c of sent) {
    expect(c.args.slice(0, 3)).toEqual([STATIC, 'Custom Chase', '201-206']);
    expect(c.args[3]).toMatch(/^[0-9A-F]{12}$/);
  }
  // It moves, and the channels are spread along the wave rather than all alike.
  expect(new Set(sent.map((c) => c.args[3])).size).toBeGreaterThan(3);
  expect(new Set(last(sent).args[3].match(/../g)).size).toBeGreaterThan(1);

  await page.locator('#dmxSineStopBtn').click();
  await expect(page.locator('#dmxSineStartBtn')).toBeEnabled();
  await page.waitForTimeout(300);     // a request already on its way
  const n = sent.length;
  await page.waitForTimeout(600);
  expect(sent.length, 'still sending after Stop').toBe(n);
  // The faders stay where the wave left them, and the test stays on.
  await expect(page.locator('#dmxTestEnabled')).toBeChecked();

  // Set All ends a running wave too.
  await page.locator('#dmxSineStartBtn').click();
  await expect(page.locator('#dmxSineStopBtn')).toBeEnabled();
  await page.locator('[onclick="DMXSetAll(0);"]').click();
  await expect(page.locator('#dmxSineStartBtn')).toBeEnabled();
  await expect.poll(() => last(sent).args[3]).toBe('000000000000');
});

test('enabling the faders takes the test over from Channel Testing, and a refusal is reported', async ({ page }) => {
  const sent = await open(page);
  await page.locator('#tab-channels-tab').click();
  await page.locator('#testModeEnabled').check();
  await expect.poll(() => sent.length).toBeGreaterThan(0);

  await page.locator('#tab-dmx-tab').click();
  await setField(page, 'dmxChannelCount', '2');
  await page.locator('#dmxTestEnabled').check();
  await expect.poll(() => last(sent).args.slice(1)).toEqual(['Custom Chase', '1-2', '0000']);
  await expect(page.locator('#testModeEnabled'), 'two tabs both claim the one test').not.toBeChecked();

  await page.route((u) => u.pathname.endsWith('/api/command'), (route) => route.fulfill({ status: 500, body: 'refused' }));
  await setValue(page, 0, '9');
  await expect(page.locator('#dialogOKPopup .modal-title')).toHaveText('Failed to set DMX Test Mode');
});
