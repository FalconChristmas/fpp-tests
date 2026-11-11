import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container } from './container';
import { snapshotSettings } from './settings-file';

// The GPIO Inputs page's edit dialog: the OLED Navigation command it adds to
// the command lists, and how the dialog sits in a short window.  The container
// has no OLED, so what the OLED reads (FPPStatusOLEDPage.cpp, the action
// string) is the value saved in the input's JSON.

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
  await request.post(GPIO, { data: Buffer.from(saved ?? '[]') });
  restoreSettings();
});

async function putGpio(request: APIRequestContext, body: unknown) {
  const r = await request.post(GPIO, { data: Buffer.from(JSON.stringify(body)) });
  expect(r.ok(), await r.text()).toBe(true);
}

const input = {
  pin: 'TF-1', enabled: true, mode: 'gpio', desc: 'fpp-tests input', debounceTime: 100, debounceEdge: 'both',
  rising: [], falling: [], holdTime: 0, hold: [],
};

async function openEdit(page: Page) {
  await page.goto('/gpio.php');
  const card = page.locator('.gpio-trigger-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('button', { hasText: 'Edit' }).click();
  const modal = page.locator('#gpioEditModal');
  await expect(modal).toBeVisible();
  // A Bootstrap .fade modal is visible while its dialog is still sliding
  // down 50px into place (0.3s); anything measured before then is off by
  // the rest of the slide.
  await expect.poll(() => modal.locator('.modal-dialog').evaluate((e) => getComputedStyle(e).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  return modal;
}

test('OLED Navigation offers Test Multisync, and saves it for the OLED to act on', async ({ page, request }) => {
  // Regression: e937b0188.  The OLED code handles a "Test Multisync" action
  // (it starts the multisync test pattern screen), but the Action list on
  // the GPIO page stopped at "Test/Down", so no button could be set to it.
  await putGpio(request, [input]);
  const modal = await openEdit(page);
  await modal.locator('button', { hasText: 'Add Command' }).first().click();

  const editor = page.locator('#commandEditorPopup');
  await expect(editor.locator('#editorCommand')).toBeVisible({ timeout: 15_000 });
  await editor.locator('#editorCommand').selectOption('OLED Navigation');
  const action = editor.locator('select').filter({ has: page.locator('option[value="Test/Down"]') });
  await expect(action).toBeVisible();
  // The control: the older entries are still there beside it.
  expect(await action.locator('option').allInnerTexts()).toEqual(
    expect.arrayContaining(['Up', 'Down', 'Back', 'Enter', 'Test', 'Test/Down', 'Test Multisync']));
  await action.selectOption('Test Multisync');
  await editor.locator('#btnSaveEditorCommand').click();

  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
  await expect.poll(async () => ((await (await request.get(GPIO)).json()) as any[])[0].rising
    .map((c: any) => ({ command: c.command, args: c.args })), { timeout: 15_000 })
    .toEqual([{ command: 'OLED Navigation', args: ['Test Multisync'] }]);
});

test('the edit dialog grows down to the bottom of a short window and scrolls inside', async ({ page, request }) => {
  // Regression: e2c21dc35.  fpp.css gave the dialog a fixed height and capped
  // its body at 100vh - 8rem, so on a small screen the box stopped well short
  // of the bottom with dead space under it and its buttons had little room.
  await putGpio(request, [input]);
  for (const height of [500, 640]) {
    await page.setViewportSize({ width: 1000, height });
    const modal = await openEdit(page);
    const box = (await modal.locator('.modal-content').boundingBox())!;
    const bottomGap = height - (box.y + box.height);
    expect(bottomGap, `${height}px window: gap under the dialog`).toBeGreaterThanOrEqual(0);
    expect(bottomGap, `${height}px window: dead space under the dialog`).toBeLessThanOrEqual(16);
    // The footer's buttons are inside the window, not pushed off it.
    const save = (await modal.locator('button[onclick="saveGPIOModal()"]').boundingBox())!;
    expect(save.y + save.height).toBeLessThanOrEqual(height);
    // The body is what scrolls.
    expect(await modal.locator('.modal-body').evaluate((e) => e.scrollHeight > e.clientHeight), `${height}px: body scrolls`).toBe(true);
  }
});
