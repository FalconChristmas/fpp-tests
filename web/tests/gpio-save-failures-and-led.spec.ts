import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The GPIO Inputs page with the player's part mocked: the page reads
// gpio.json from a canned list and its Save is caught, so nothing is written.
// What the page says when the save is refused, what it posts for an LED and a
// re-enable rule, and editing a command already on an input (www/gpio.php
// saveGPIOInputs, buildTriggerCard, updateLEDVisibility, editModalCmd).

const trigger = (over: object = {}) => ({
  pin: 'TF-1', enabled: true, mode: 'gpio', desc: 'fpp-tests input', debounceTime: 100, debounceEdge: 'both',
  rising: [], falling: [], holdTime: 0, hold: [], ...over,
});

type Answer = { status?: number; body: string };
async function open(page: Page, triggers: object[], answer: () => Answer) {
  const posted: any[] = [];
  await page.route((u) => u.pathname.endsWith('/api/configfile/gpio.json'), async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(JSON.parse(route.request().postData() ?? 'null'));
      const a = answer();
      return route.fulfill({ status: a.status ?? 200, contentType: 'application/json', body: a.body });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(triggers) });
  });
  await page.goto('/gpio.php');
  await expect(page.locator('.gpio-trigger-card')).toHaveCount(triggers.length, { timeout: 15_000 });
  return posted;
}

async function openEdit(page: Page, n = 0) {
  await page.locator('.gpio-trigger-card').nth(n).locator('button', { hasText: 'Edit' }).click();
  const modal = page.locator('#gpioEditModal');
  await expect(modal).toBeVisible();
  return modal;
}
const savePage = (page: Page) => page.locator('input[value="Save"][onclick="saveGPIOInputs()"]').click();
const refused: Answer = { body: JSON.stringify({ Status: 'Error', Message: 'fpp-tests: no room' }) };

test('a refused save shows the player\'s reason, a failed one says it failed, and neither says Saved', async ({ page }) => {
  let answer: Answer = refused;
  const posted = await open(page, [trigger()], () => answer);
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  await savePage(page);
  await expect.poll(() => dialogs).toEqual(['ERROR: fpp-tests: no room']);

  answer = { status: 500, body: 'no' };
  await savePage(page);
  await expect.poll(() => dialogs).toEqual(['ERROR: fpp-tests: no room', 'Error: Failed to save GPIO triggers']);

  expect(posted).toHaveLength(2);
  expect(posted[0]).toMatchObject([{ pin: 'TF-1', desc: 'fpp-tests input', reEnableMode: 'always', ledPin: '' }]);
  await expect(page.locator('.jGrowl-notification', { hasText: 'GPIO Triggers Saved' })).toHaveCount(0);
});

test('a card shows how its input is re-enabled, and the rule is posted as it was read', async ({ page }) => {
  const posted = await open(page, [
    trigger({ reEnableMode: 'timed', reEnableDelay: 2500 }),
    trigger({ pin: 'TF-2', reEnableMode: 'player_idle' }),
    trigger({ pin: 'TF-3' }),
  ], () => refused);
  page.on('dialog', (d) => d.accept());
  const cards = page.locator('.gpio-trigger-card');
  await expect(cards.nth(0).locator('.badge[title="Re-enable after delay"]')).toHaveText('2500ms');
  await expect(cards.nth(1).locator('.badge[title="Re-enable on player idle"]')).toHaveText('On idle');
  await expect(cards.nth(2).locator('.badge[title^="Re-enable"]')).toHaveCount(0);

  // The dialog shows the delay only for the timed rule.
  const modal = await openEdit(page, 0);
  await expect(modal.locator('#gpioModalReEnableMode')).toHaveValue('timed');
  await expect(modal.locator('#gpioModalReEnableDelay')).toHaveValue('2500');
  await modal.locator('#gpioModalReEnableMode').selectOption('player_idle');
  await expect(modal.locator('#gpioReEnableDelayRow')).toBeHidden();
  await modal.locator('#gpioModalReEnableMode').selectOption('timed');
  await modal.locator('#gpioModalReEnableDelay').fill('900');
  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await expect(cards.nth(0).locator('.badge[title="Re-enable after delay"]')).toHaveText('900ms');

  await savePage(page);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].map((t: any) => [t.pin, t.reEnableMode, t.reEnableDelay]))
    .toEqual([['TF-1', 'timed', 900], ['TF-2', 'player_idle', 0], ['TF-3', 'always', 0]]);
});

test('the LED\'s trigger number is a count of flashes or a time, by the mode, and is posted with it', async ({ page }) => {
  const posted = await open(page, [trigger()], () => refused);
  page.on('dialog', (d) => d.accept());
  const modal = await openEdit(page);
  const row = modal.locator('#gpioLEDTriggerParamRow');
  const label = modal.locator('#gpioLEDTriggerParamLabel');

  await expect(modal.locator('#gpioLEDSettingsRow')).toBeHidden();
  await modal.locator('#gpioModalLedPin').selectOption('TF-5');
  await expect(modal.locator('#gpioLEDSettingsRow')).toBeVisible();
  await expect(row, 'follow the input: nothing to count').toBeHidden();

  await modal.locator('#gpioModalLedTriggerMode').selectOption('timed_on');
  await expect(label).toContainText('On duration (ms)');
  await modal.locator('#gpioModalLedTriggerMode').selectOption('flash');
  await expect(label).toContainText('Number of flashes');
  await expect(modal.locator('#gpioLEDTriggerParamHelp')).toHaveText('How many times the LED flashes before returning to idle.');
  await modal.locator('#gpioModalLedTriggerParam').fill('4');
  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await expect(page.locator('.gpio-trigger-card .badge.bg-warning')).toContainText('TF-5');

  await savePage(page);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0][0]).toMatchObject({ pin: 'TF-1', ledPin: 'TF-5', ledTriggerMode: 'flash', ledTriggerParam: 4, ledActiveHigh: true });
});

test('an LED on a pin the player no longer offers stays on the input, marked reserved', async ({ page }) => {
  const posted = await open(page, [trigger({ ledPin: 'FPP-TESTS-GONE', ledTriggerMode: 'flash', ledTriggerParam: 2 })], () => refused);
  page.on('dialog', (d) => d.accept());
  const modal = await openEdit(page);
  const led = modal.locator('#gpioModalLedPin');
  await expect(led).toHaveValue('FPP-TESTS-GONE');
  await expect(led.locator('option:checked')).toContainText('reserved: in use');
  await modal.locator('#gpioModalDesc').fill('renamed');
  await modal.locator('button[onclick="saveGPIOModal()"]').click();

  await savePage(page);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0][0]).toMatchObject({ desc: 'renamed', ledPin: 'FPP-TESTS-GONE', ledTriggerMode: 'flash', ledTriggerParam: 2 });
});

test('editing a command on an input changes that command in place', async ({ page }) => {
  const posted = await open(page, [trigger({ rising: [
    { command: 'OLED Navigation', args: ['Up'] },
    { command: 'OLED Navigation', args: ['Enter'] },
  ] })], () => refused);
  page.on('dialog', (d) => d.accept());
  const modal = await openEdit(page);
  const rows = modal.locator('#gpioModal_rising_list .gpio-cmd-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(1).locator('button[title="Edit"]').click();

  const editor = page.locator('#commandEditorPopup');
  await expect(editor.locator('#editorCommand')).toHaveValue('OLED Navigation', { timeout: 15_000 });
  await expect(page.getByText('Edit Command — Rising Edge')).toBeVisible();
  const action = editor.locator('select').filter({ has: page.locator('option[value="Test/Down"]') });
  await expect(action).toHaveValue('Enter');
  await action.selectOption('Back');
  await editor.locator('#btnSaveEditorCommand').click();
  await expect(rows).toHaveCount(2);

  await modal.locator('button[onclick="saveGPIOModal()"]').click();
  await savePage(page);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0][0].rising.map((c: any) => [c.command, c.args]))
    .toEqual([['OLED Navigation', ['Up']], ['OLED Navigation', ['Back']]]);
});
