import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';

// A pin a cape's inputs have claimed (media/tmp/cape-inputs.json) is not
// offered to the GPIO Inputs page; an input saved on it before then keeps its
// pin, flagged with what holds it (Feature: 7f005883d).

test.skip(!container, 'changes the player\'s GPIO config');

const GPIO = 'api/configfile/gpio.json';
const CAPE_INPUTS = '/home/fpp/media/tmp/cape-inputs.json';
let saved: string | null = null;
let restoreSettings: () => void = () => {};

async function put(request: APIRequestContext, body: string) {
  const r = await request.post(GPIO, { data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
}

test.beforeEach(async ({ request }) => {
  restoreSettings = snapshotSettings();
  const r = await request.get(GPIO);
  saved = r.ok() ? await r.text() : null;
});
test.afterEach(async ({ request }) => {
  await put(request, saved ?? '[]');
  inPlayer('rm', '-f', CAPE_INPUTS);
  restoreSettings();
});

test('an input on a pin a cape has claimed names the claim when it is edited', async ({ page, request }) => {
  await put(request, JSON.stringify([{ pin: 'TF-1', enabled: true, mode: 'gpio', desc: 'fpp-tests input',
    debounceTime: 100, debounceEdge: 'both', rising: [], falling: [], holdTime: 0, hold: [] }]));
  inPlayer('sh', '-c', `mkdir -p /home/fpp/media/tmp && printf '%s' '{"inputs":[{"pin":"TF-1","type":"fpp-tests-button"}]}' > ${CAPE_INPUTS}`);
  await page.goto('/gpio.php');
  const card = page.locator('.gpio-trigger-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button', { hasText: 'Edit' }).click();
  await expect(page.locator('#gpioModalPin option:checked')).toContainText('reserved: fpp-tests-button');
  // and the claimed pin is listed once, as the reserved one
  const texts = await page.locator('#gpioModalPin option').allInnerTexts();
  expect(texts.filter((t) => /^TF-1\b/.test(t))).toHaveLength(1);
});
