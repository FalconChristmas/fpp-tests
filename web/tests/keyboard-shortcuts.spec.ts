import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

// Custom keyboard shortcuts (Settings -> UI -> Keyboard Shortcuts), stored as
// a JSON array in the keyBindings setting and dispatched by fpp.js on every
// page.  Commands the shortcuts run are caught at api/command, so nothing
// actually runs on the player.

type Binding = Record<string, unknown>;

async function setBindings(request: APIRequestContext, bindings: Binding[]) {
  const r = await request.put('/api/settings/keyBindings', { data: JSON.stringify(bindings) });
  expect(r.ok(), await r.text()).toBe(true);
}

// Every api/command a shortcut sends, answered here instead of by fppd.
async function catchCommands(page: Page): Promise<unknown[]> {
  const sent: unknown[] = [];
  await page.route('**/api/command', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: 'OK' } });
  });
  return sent;
}

async function openIndex(page: Page) {
  await page.goto('/index.php');
  await page.locator('#bodyWrapper').waitFor({ state: 'visible' });
  // The dispatcher is bound at document ready.
  await page.waitForFunction(() => typeof (window as any).KeyBindingsHandleEvent === 'function' && document.readyState === 'complete');
  // Keys go to the page, not to whatever field has focus.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/keyBindings', { data: '[]' });
  await request.put('/api/settings/uiLevel', { data: '0' });
});

test('a saved shortcut runs its command or preset, read back as the array it was saved as', async ({ page, request }) => {
  // Feature: 574bf28ae (#3008).  config.php's settings reader stripped every
  // quote out of a stored value that was not a JSON object, so the array came
  // to the page as [{key:Ctrl+Alt+P,...}] and no shortcut ever matched.
  const bindings = [
    { key: 'Ctrl+Alt+P', action: 'command', command: 'Volume Set', args: ['50'] },
    { key: 'Alt+1', action: 'preset', preset: 'fpp-tests "quoted" preset' },
  ];
  await setBindings(request, bindings);
  const sent = await catchCommands(page);
  await openIndex(page);

  const stored = await page.evaluate(() => (window as any).settings['keyBindings']);
  expect(JSON.parse(stored)).toEqual(bindings);

  await page.keyboard.press('Control+Alt+KeyP');
  await expect.poll(() => sent.length).toBe(1);
  await page.keyboard.press('Alt+Digit1');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent).toEqual([
    { command: 'Volume Set', args: ['50'] },
    { command: 'Trigger Command Preset', args: ['fpp-tests "quoted" preset'] },
  ]);
});

test('a page shortcut only ever opens an FPP page', async ({ page, request }) => {
  // Regression: f7e5b25f2.  A 'page' shortcut navigated to whatever string
  // was stored: a javascript: URL ran in the UI's origin, and another host was
  // followed.
  await setBindings(request, [
    { key: 'Alt+2', action: 'page', page: 'javascript:void(window.__fppTestsKB=1)' },
    { key: 'Alt+3', action: 'page', page: 'http://fpp-tests.invalid/index.php' },
    { key: 'Alt+4', action: 'page', page: 'about.php' },
  ]);
  const offsite: string[] = [];
  await page.route('http://fpp-tests.invalid/**', (route) => {
    offsite.push(route.request().url());
    return route.fulfill({ body: 'offsite' });
  });
  await openIndex(page);
  const start = page.url();

  await page.keyboard.press('Alt+Digit2');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__fppTestsKB)).toBeUndefined();

  await page.keyboard.press('Alt+Digit3');
  await page.waitForTimeout(1000);
  expect(offsite, 'the shortcut followed a link to another host').toEqual([]);
  expect(page.url()).toBe(start);

  // The control: a shortcut to an FPP page still opens it.
  await page.keyboard.press('Alt+Digit4');
  await expect(page).toHaveURL(/\/about\.php$/);
});

// Regression: fe31a6415 (the next three).  F2 and F8 were reserved, so a
// shortcut on F2 was ignored and F2 still opened Settings; nothing stopped a
// shortcut taking Ctrl+C from every page; and holding a shortcut down ran it
// over and over, because jQuery's event wrapper has no 'repeat' and the check
// read it there.
test('a shortcut on F2 replaces its default', async ({ page, request }) => {
  await setBindings(request, [{ key: 'F2', action: 'page', page: 'about.php' }]);
  await openIndex(page);
  await page.keyboard.press('F2');
  await expect(page).toHaveURL(/\/about\.php$/);
});

test('a shortcut stored on a browser key is ignored', async ({ page, request }) => {
  await setBindings(request, [{ key: 'Ctrl+C', action: 'command', command: 'Volume Set', args: ['10'] }]);
  const sent = await catchCommands(page);
  await openIndex(page);
  await page.keyboard.press('Control+KeyC');
  await page.waitForTimeout(500);
  expect(sent, 'Ctrl+C ran a shortcut').toEqual([]);
});

test('holding a shortcut down runs it once', async ({ page, request }) => {
  await setBindings(request, [{ key: 'Ctrl+Alt+H', action: 'command', command: 'Volume Set', args: ['20'] }]);
  const sent = await catchCommands(page);
  await openIndex(page);
  // The first keydown and three auto-repeats.
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('KeyH');
  }
  await page.keyboard.up('KeyH');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(sent).toEqual([{ command: 'Volume Set', args: ['20'] }]);
});

test('the Keyboard Shortcuts editor is an Advanced setting', async ({ page, request }) => {
  // Regression: fe31a6415.  The section and its editor were shown at Basic
  // level; saved shortcuts keep working at any level.
  await request.put('/api/settings/uiLevel', { data: '0' });
  await page.goto('/settings.php#settings-ui');
  await expect(page.locator('#passwordEnable')).toBeAttached();
  await expect(page.locator('#keyBindingsOpenBtn')).toHaveCount(0);

  await request.put('/api/settings/uiLevel', { data: '1' });
  await page.reload();
  await expect(page.locator('#keyBindingsOpenBtn')).toBeAttached();
});
