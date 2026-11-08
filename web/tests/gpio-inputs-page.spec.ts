import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';
import { snapshotSettings } from './settings-file';

// The GPIO Inputs page (gpio.php): each input is a card; Edit opens a dialog
// whose command lists (rising, falling, hold) can be reordered and trimmed;
// the trash button removes an input; Add GPIO Trigger opens the dialog on a
// pin no input uses yet.  Nothing reaches config/gpio.json until the page's
// Save.  (gpio-*.spec.ts: single fields of the dialog and the cards.)

test.skip(!container, 'changes the player\'s GPIO config');

const GPIO = 'api/configfile/gpio.json';
let saved: string | null = null;
let restoreSettings: () => void = () => {};

test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  const r = await request.get(GPIO);
  saved = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await put(request, saved ?? '[]');
  restoreSettings();
});

async function put(request: APIRequestContext, body: unknown) {
  const r = await request.post(GPIO, { data: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}
const stored = async (request: APIRequestContext) => (await (await request.get(GPIO)).json()) as any[];

const vol = (n: number) => ({ command: 'Volume Set', args: [String(n)] });
const input = (pin: string, o: object = {}) => ({
  pin, enabled: true, mode: 'gpio', desc: `fpp-tests ${pin}`, debounceTime: 100, debounceEdge: 'both',
  rising: [], falling: [], holdTime: 0, hold: [], ...o,
});

async function openPage(page: Page, cards: number) {
  await page.goto('/gpio.php');
  const all = page.locator('.gpio-trigger-card');
  await expect(all).toHaveCount(cards, { timeout: 15_000 });
  return all;
}
async function savePage(page: Page) {
  const posted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('gpio.json'));
  await page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
  expect((await posted).ok()).toBe(true);
}
const modal = (page: Page) => page.locator('#gpioEditModal');
// Bootstrap ignores a close while the dialog is still fading in; wait it out.
async function opened(page: Page) {
  await expect(modal(page)).toBeVisible();
  await page.waitForFunction(() => {
    const m = (window as any).bootstrap.Modal.getInstance(document.getElementById('gpioEditModal'));
    return m && m._isShown && !m._isTransitioning;
  });
}
const cmdRows = (page: Page, edge: string) => modal(page).locator(`#gpioModal_${edge}_list .gpio-cmd-row`);

test('commands reordered and removed in the edit dialog are saved in that order, the rest of the input unchanged', async ({ page, request }) => {
  const pins = await availablePins(page);
  const original = input(pins[0], { rising: [vol(10), vol(20), vol(30)], falling: [vol(40), vol(50)] });
  await put(request, [original]);
  const cards = await openPage(page, 1);
  await cards.first().locator('button', { hasText: 'Edit' }).click();
  await opened(page);
  await expect(cmdRows(page, 'rising')).toHaveCount(3);
  // The first command can't go up, nor the last down.
  await expect(cmdRows(page, 'rising').nth(0).locator('button[title="Move up"]')).toBeDisabled();
  await expect(cmdRows(page, 'rising').nth(2).locator('button[title="Move down"]')).toBeDisabled();
  await cmdRows(page, 'rising').nth(0).locator('button[title="Move down"]').click();
  await cmdRows(page, 'rising').nth(2).locator('button[title="Move up"]').click();
  await cmdRows(page, 'falling').nth(0).locator('button[title="Remove"]').click();
  await expect(cmdRows(page, 'falling')).toHaveCount(1);
  await modal(page).locator('button[onclick="saveGPIOModal()"]').click();
  await expect(modal(page)).toBeHidden();
  expect((await stored(request))[0].rising.map((c: any) => c.args[0]), 'the dialog saves nothing by itself').toEqual(['10', '20', '30']);

  await savePage(page);
  const after = (await stored(request))[0];
  expect(after.rising.map((c: any) => c.args[0])).toEqual(['20', '30', '10']);
  expect(after.falling.map((c: any) => c.args[0])).toEqual(['50']);
  expect(after).toMatchObject({ pin: original.pin, enabled: true, mode: 'gpio', desc: original.desc, debounceTime: 100,
    debounceEdge: 'both', holdTime: 0, hold: [] });
});

test('Cancel in the edit dialog leaves the input as it was', async ({ page, request }) => {
  const pins = await availablePins(page);
  await put(request, [input(pins[0], { rising: [vol(10), vol(20)] })]);
  const cards = await openPage(page, 1);
  await cards.first().locator('button', { hasText: 'Edit' }).click();
  await opened(page);
  await cmdRows(page, 'rising').nth(0).locator('button[title="Remove"]').click();
  await modal(page).locator('#gpioModalDesc').fill('fpp-tests changed');
  await modal(page).locator('#gpioModalEnabled').uncheck();
  await modal(page).locator('button', { hasText: 'Cancel' }).click();
  await expect(modal(page)).toBeHidden();
  await expect(cards.first()).toContainText(`fpp-tests ${pins[0]}`);
  await expect(cards.first().locator('.badge', { hasText: 'Enabled' })).toBeVisible();

  // Opened again, it shows both commands; saved, it is as it was.
  await cards.first().locator('button', { hasText: 'Edit' }).click();
  await opened(page);
  await expect(cmdRows(page, 'rising')).toHaveCount(2);
  await modal(page).locator('button', { hasText: 'Cancel' }).click();
  await expect(modal(page)).toBeHidden();
  await savePage(page);
  const after = (await stored(request))[0];
  expect(after.rising.map((c: any) => c.args[0])).toEqual(['10', '20']);
  expect(after).toMatchObject({ desc: `fpp-tests ${pins[0]}`, enabled: true });
});

test('an input deleted from its card is gone once saved, and Cancel on the question keeps it', async ({ page, request }) => {
  const pins = await availablePins(page);
  await put(request, [input(pins[0]), input(pins[1])]);
  const cards = await openPage(page, 2);
  page.once('dialog', (d) => d.dismiss());
  await cards.nth(0).locator('button.btn-outline-danger').click();
  await expect(cards).toHaveCount(2);
  page.once('dialog', (d) => { expect(d.message()).toContain(pins[0]); d.accept(); });
  await cards.nth(0).locator('button.btn-outline-danger').click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(pins[1]);
  expect((await stored(request)).length, 'the delete saves nothing by itself').toBe(2);
  await savePage(page);
  expect((await stored(request)).map((t) => t.pin)).toEqual([pins[1]]);
});

test('Add GPIO Trigger starts on a pin no input uses, and does not offer the used ones', async ({ page, request }) => {
  const pins = await availablePins(page);
  await put(request, [input(pins[0])]);
  await openPage(page, 1);
  await page.locator('button[onclick="openAddModal()"]').click();
  await opened(page);
  await expect(modal(page).locator('#gpioModalPin')).toHaveValue(pins[1]);
  const offered = await modal(page).locator('#gpioModalPin option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(offered).not.toContain(pins[0]);
  await modal(page).locator('#gpioModalDesc').fill('fpp-tests added');
  await modal(page).locator('button[onclick="saveGPIOModal()"]').click();
  await expect(page.locator('.gpio-trigger-card')).toHaveCount(2);
  await savePage(page);
  const after = await stored(request);
  expect(after.map((t) => t.pin)).toEqual([pins[0], pins[1]]);
  expect(after[1]).toMatchObject({ enabled: true, desc: 'fpp-tests added', debounceTime: 100, rising: [], falling: [] });
});

// The pins this player offers, from the page itself.
async function availablePins(page: Page): Promise<string[]> {
  await page.goto('/gpio.php');
  const pins = await page.evaluate(() => (window as any).availablePins as string[]);
  expect(pins.length, 'the control: the player offers at least two GPIO pins').toBeGreaterThanOrEqual(2);
  return pins;
}
