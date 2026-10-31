import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Help menu and the Get Help page (help.php): where a user is sent for
// the manual, the forums, the issue tracker and the topic help pages, and
// the menu entries only shown from the Advanced UI level.

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: '0' });
});

const helpMenu = (page: Page) => page.locator('#navbarDropdownMenuLinkHelp + .dropdown-menu');

test('the Help menu sends the user to Get Help, which has the places to get help', async ({ page }) => {
  // Feature: fa7ecf6d6.  The manual, forum and issue tracker links, and the
  // API help, moved out of the Help menu to a "Get Help" page, which also
  // names the Facebook group and the Zoom room.  Also covers 6ee57a954, which
  // added the Issue Tracker link (to the menu then, to Get Help since).
  await page.goto('/index.php');
  await page.locator('#navbarDropdownMenuLinkHelp').click();
  const menu = helpMenu(page);
  await expect(menu).toBeVisible();
  await expect(menu.locator('a[href="help.php"]')).toHaveText(/Get\s+Help/);
  for (const gone of ['https://falconchristmas.com/forum', 'https://github.com/FalconChristmas/fpp/issues',
                      'commandhelp.php']) {
    await expect(menu.locator(`a[href="${gone}"]`), `${gone} is on Get Help, not in the menu`).toHaveCount(0);
  }
  await expect(menu.locator('a.link-to-fpp-manual')).toHaveCount(0);

  await menu.locator('a[href="help.php"]').click();
  await expect(page).toHaveURL(/\/help\.php$/);
  const places = page.locator('.pageContent');
  const link = (text: RegExp) => places.locator('a', { hasText: text });
  await expect(link(/Issue\s+Tracker/)).toHaveAttribute('href', 'https://github.com/FalconChristmas/fpp/issues');
  await expect(link(/Issue\s+Tracker/)).toHaveAttribute('target', '_blank');
  await expect(link(/FPP\s+Forums/)).toHaveAttribute('href', 'https://falconchristmas.com/forum');
  await expect(link(/Facebook\s+group/)).toHaveAttribute('href', /facebook\.com\/groups\//);
  await expect(link(/Zoom\s+room/)).toHaveAttribute('href', 'https://xlights.org/zoom/');
  await expect(link(/FPP\s+Commands\s+Help/)).toHaveAttribute('href', 'commandhelp.php');
  // The manual link's address is filled in by fpp.js for this version.
  const manual = places.locator('a.link-to-fpp-manual');
  await expect(manual).toHaveCount(1);
  await expect(manual).not.toHaveAttribute('href', /added-by-javascript/);
  await expect(manual).toHaveAttribute('href', /^https?:\/\//);
});

test('Get Help\'s three sections sit side by side on a wide screen and stack on a phone', async ({ page }) => {
  // Feature: 997c3d244 ("Make help page responsive html").  The page was one
  // fieldset with the sections one under another; it became a Bootstrap row
  // of columns, three across from xl widths and one per line on a phone.
  const sections = page.locator('.pageContent h3');
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/help.php');
  await expect(sections).toHaveText(['Places to get help', 'FPP API', 'Specific Topics']);
  const wide = await Promise.all([0, 1, 2].map((i) => sections.nth(i).boundingBox()));
  expect(wide.every((b) => b), JSON.stringify(wide)).toBe(true);
  // One row: the same top, left to right.
  expect(Math.abs(wide[0]!.y - wide[2]!.y), JSON.stringify(wide)).toBeLessThan(2);
  expect(wide[0]!.x).toBeLessThan(wide[1]!.x);
  expect(wide[1]!.x).toBeLessThan(wide[2]!.x);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/help.php?narrow');
  await expect(sections).toHaveCount(3);
  const narrow = await Promise.all([0, 1, 2].map((i) => sections.nth(i).boundingBox()));
  // One column: each section under the one before, at the same left edge.
  expect(narrow[0]!.y).toBeLessThan(narrow[1]!.y);
  expect(narrow[1]!.y).toBeLessThan(narrow[2]!.y);
  expect(Math.abs(narrow[0]!.x - narrow[2]!.x), JSON.stringify(narrow)).toBeLessThan(2);
});

test('Get Help fits a phone\'s width, and hides its outside links when external URLs are hidden', async ({ page }) => {
  // Regression: fpp 1d0dece55.  Get Help's links borrowed the Help menu's
  // dropdown-item class, which doesn't wrap: at 390px the page was 427px
  // wide and scrolled sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/help.php');
  const issues = page.locator('.pageContent a', { hasText: /Issue\s+Tracker/ });
  await expect(issues).toBeVisible();
  const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(width[0], `page width ${width[0]} at a ${width[1]}px viewport`).toBeLessThanOrEqual(width[1]);

  // Asked to hide external URLs (config.php's hideExternalURLs, set by a
  // Hide-External-Links header or a local kiosk), it hides them, and only them.
  // Also 03e3588df: the header is what config.php reads (without it the links
  // stay).
  await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
  await page.goto('/help.php?hidden');
  for (const text of [/Issue\s+Tracker/, /FPP\s+Forums/, /Facebook\s+group/, /Zoom\s+room/]) {
    await expect(page.locator('.pageContent a', { hasText: text }), String(text)).toBeHidden();
  }
  await expect(page.locator('.pageContent a.link-to-fpp-manual')).toBeHidden();
  await expect(page.locator('.pageContent a', { hasText: /FPP\s+Commands\s+Help/ })).toBeVisible();
});

test('Get Help\'s MQTT topic opens the MQTT help', async ({ page }) => {
  // Feature: 8f211b928 ("add dedicated help page for MQTT"): help/mqtt.php,
  // listed under Specific Topics.
  await page.goto('/help.php');
  await page.waitForFunction(() => typeof (window as any).DisplayHelp === 'function');
  const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === '/help/mqtt.php');
  await page.locator('.pageContent a', { hasText: /MQTT\s+Integration/ }).click();
  expect((await loaded).status()).toBe(200);
  await expect(page.locator('#helpDialog.show')).toBeVisible();
  await expect(page.locator('#helpDialogText')).toContainText('MQTT Topics Published by FPP');
});

test('Script Repository and Output Processors are in the menus only from the Advanced UI level', async ({ page, request }) => {
  // Feature: 0f0d6105e.  Both were listed at the Basic level too.
  const entry = (href: string) => page.locator(`.navbar .dropdown-menu a[href="${href}"]`);
  await request.put('/api/settings/uiLevel', { data: '0' });
  await page.goto('/index.php');
  await expect(entry('playlists.php'), 'the Content Setup menu is there').toHaveCount(1);
  await expect(entry('channeloutputs.php'), 'the Input/Output menu is there').toHaveCount(1);
  await expect(entry('scriptbrowser.php')).toHaveCount(0);
  await expect(entry('outputprocessors.php')).toHaveCount(0);

  await request.put('/api/settings/uiLevel', { data: '1' });
  await page.goto('/index.php');
  await expect(entry('scriptbrowser.php')).toHaveCount(1);
  await expect(entry('outputprocessors.php')).toHaveCount(1);
  await page.locator('#navbarDropdownMenuLinkInOut').click();
  await expect(entry('outputprocessors.php')).toBeVisible();
});
