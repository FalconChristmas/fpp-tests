import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The UI setting that turns off jGrowl's pop-up notices
// (disableUIPopoverAlerts): menuHead.inc loads either jGrowl or a stand-in
// $.jGrowl that writes the notice to the console instead.  The setting is
// read from the settings file as each page is built, so the page is the
// receiving end.

test.skip(!container, 'edits the settings file inside the run-web.sh container');

const SETTINGS = '/home/fpp/media/settings';
const NAME = 'disableUIPopoverAlerts';

function settingLine(): string {
  return inPlayer('sh', '-c', `grep '^${NAME} ' ${SETTINGS} || true`).trim();
}
function unset() {
  inPlayer('sed', '-i', `/^${NAME} /d`, SETTINGS);
}

let saved = '';
test.beforeEach(() => {
  saved = settingLine();
});
test.afterEach(() => {
  unset();
  if (saved) {
    inPlayer('sh', '-c', 'printf "%s\\n" "$1" >> "$2"', 'sh', saved, SETTINGS);
  }
});

// Loads the status page and raises a notice the way the pages do.
async function growl(page: Page, message: string) {
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).$?.jGrowl === 'function');
  await page.evaluate((m) => (window as any).$.jGrowl(m, { themeState: 'detract' }), message);
}
const scriptsLoaded = (page: Page) =>
  page.evaluate(() => [...document.scripts].map((s) => s.getAttribute('src') || '').filter((s) => /jgrowl/i.test(s)));

test('a player that never set the option shows its notices', async ({ page }) => {
  // Feature: 31c275571; fcd5cef99 made menuHead.inc treat a missing
  // setting as "0" too, though config.php already fills in the setting's
  // default ("0", from settings.json) before the page reads it.
  unset();
  expect(settingLine()).toBe('');
  await growl(page, 'fpp-tests notice on a fresh player');
  await expect(page.locator('.jGrowl-notification', { hasText: 'fpp-tests notice on a fresh player' })).toBeVisible();
  expect(await scriptsLoaded(page)).toEqual([expect.stringMatching(/^js\/jquery\.jgrowl\.min\.js/)]);
});

test('turning the option on keeps notices off the page', async ({ page, request }) => {
  // Feature: 31c275571.  The option is saved as a setting; with it on the
  // page gets the stand-in $.jGrowl, and no notice is drawn.
  expect((await request.put(`/api/settings/${NAME}`, { data: '1' })).ok()).toBe(true);
  expect(settingLine()).toBe(`${NAME} = "1"`);
  await growl(page, 'fpp-tests notice with notices off');
  expect(await scriptsLoaded(page)).toEqual([expect.stringMatching(/^js\/jquery\.jgrowl\.disabled\.js/)]);
  await page.waitForTimeout(500);
  await expect(page.locator('.jGrowl-notification')).toHaveCount(0);

  // The control: turned off again, the same notice shows.
  expect((await request.put(`/api/settings/${NAME}`, { data: '0' })).ok()).toBe(true);
  await growl(page, 'fpp-tests notice with notices on');
  await expect(page.locator('.jGrowl-notification', { hasText: 'fpp-tests notice with notices on' })).toBeVisible();
});

test('a notice kept off the page goes to the console', async ({ page, request }) => {
  // Regression: fcd5cef99, 4d3a89e97.  The stand-in dropped the notice
  // without a trace (fcd5cef99 logs it), and 4d3a89e97 labels the line so
  // it can be told apart from the page's own logging.
  expect((await request.put(`/api/settings/${NAME}`, { data: '1' })).ok()).toBe(true);
  const logged: string[] = [];
  page.on('console', (m) => logged.push(m.text()));
  await growl(page, 'fpp-tests notice for the console');
  await expect.poll(() => logged.filter((l) => l.includes('fpp-tests notice for the console'))).toEqual([
    'UI jGrowl Notification suppressed: fpp-tests notice for the console',
  ]);
});

test('a setting value other than 0 or 1 still shows notices', async ({ page }) => {
  // Regression: fpp f7bf0c442.  menuHead.inc loaded jGrowl for "0" (or no
  // setting) and the stand-in for "1", and nothing at all for anything
  // else (an empty value, say): every page's $.jGrowl call then threw.
  unset();
  inPlayer('sh', '-c', `printf '%s\\n' '${NAME} = ""' >> ${SETTINGS}`);
  expect(settingLine()).toBe(`${NAME} = ""`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.php');
  expect(await scriptsLoaded(page)).toEqual([expect.stringMatching(/^js\/jquery\.jgrowl\.min\.js/)]);
  await page.evaluate(() => (window as any).$.jGrowl('fpp-tests notice with an empty setting'));
  await expect(page.locator('.jGrowl-notification', { hasText: 'fpp-tests notice with an empty setting' })).toBeVisible();
  expect(errors).toEqual([]);
});
