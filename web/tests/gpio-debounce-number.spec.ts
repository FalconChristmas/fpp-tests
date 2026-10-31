import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container } from './container';
import { snapshotSettings } from './settings-file';

// The GPIO Inputs page saves an input's debounce time as a number
// (Regression: 56d686dcc "Save as int, not string"): the text box's value
// went into config/gpio.json as the string "300", which fppd's loader reads
// as nothing.

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

async function put(request: APIRequestContext, body: string) {
  const r = await request.post(GPIO, { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}

test('a debounce time typed in the edit dialog is saved as a number', async ({ page, request }) => {
  await put(request, JSON.stringify([{ pin: 'TF-1', enabled: true, mode: 'gpio', desc: 'fpp-tests input',
    debounceTime: 100, debounceEdge: 'both', rising: [], falling: [], holdTime: 0, hold: [] }]));
  await page.goto('/gpio.php');
  const card = page.locator('.gpio-trigger-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button', { hasText: 'Edit' }).click();
  const modal = page.locator('#gpioEditModal');
  await expect(modal).toBeVisible();
  await modal.locator('#gpioModalDebounce').fill('300');
  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
  await expect.poll(async () => ((await (await request.get(GPIO)).json()) as any[])[0].debounceTime, { timeout: 15_000 }).toBe(300);
});
