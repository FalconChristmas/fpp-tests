import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { keepingSettings, readSettingsFile, setSettingInFile } from './privacy-helpers';

// The UI level (uiLevel: 0 Basic, 1 Advanced, 2 Experimental, 3 Developer)
// decides what the pages offer.  A Basic player can unlock Advanced for 15
// minutes from Settings > UI without changing the saved level: a cookie
// holding the expiry, which config.php honours while it is in the future.

test.skip(!container, 'sets the UI level in the settings file inside the run-web.sh container');

const TOGGLE_ROW = (page: Page) => page.locator('#settings-ui .description', { hasText: 'Temporary User Interface Level' });

// A fresh load each time: a goto to the same URL with a #fragment would not
// reload the page.
async function uiTab(page: Page) {
  await page.goto(`/settings.php?fpp-tests=${Date.now()}`);
  await page.click('#settings-ui-tab');
}

const levelInPage = (page: Page) => page.evaluate(() => String((window as any).settings?.uiLevel));
const menuHasVariables = (page: Page) => page.locator('a.dropdown-item[href="variables.php"]').count();

test('Basic can switch to Advanced for 15 minutes and back, without changing the saved level', async ({ page, context, baseURL }) => {
  // Feature: c2a4607bb ("add temporary session-based Advanced UI level
  // override").
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '0');
    await uiTab(page);
    expect(await levelInPage(page)).toBe('0');
    await page.click('input[type=button][value="Change to Advanced UI for 15 Minutes"]');
    await page.waitForLoadState('load');
    const cookie = (await context.cookies()).find((c) => c.name === 'fppUiLevelOverrideExp');
    expect(cookie, 'no override cookie').toBeDefined();
    expect(Number(cookie!.value) - Date.now() / 1000).toBeGreaterThan(14 * 60);
    expect(Number(cookie!.value) - Date.now() / 1000).toBeLessThan(16 * 60);

    // What the server makes of it: every page is at Advanced.
    await uiTab(page);
    expect(await levelInPage(page)).toBe('1');
    await expect(page.locator('#header_uiLevelOverride')).toHaveCount(1);
    expect(await menuHasVariables(page), 'the Advanced menu entries are missing').toBeGreaterThan(0);
    expect(readSettingsFile()).toMatch(/^uiLevel = "0"$/m);

    await page.click('input[type=button][value="Exit Advanced Mode"]');
    await page.waitForLoadState('load');
    await uiTab(page);
    expect(await levelInPage(page)).toBe('0');
    await expect(page.locator('#header_uiLevelOverride')).toHaveCount(0);

    // An expired cookie does nothing.
    await context.addCookies([{ name: 'fppUiLevelOverrideExp', value: String(Math.floor(Date.now() / 1000) - 60), url: baseURL! }]);
    await uiTab(page);
    expect(await levelInPage(page)).toBe('0');
    await context.clearCookies();
  });
});

test('the temporary UI level row is only on a Basic player', async ({ page }) => {
  // Regression: 67a8af06f.  At Advanced and above the row was still printed,
  // with its label and no button.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await uiTab(page);
    await expect(page.locator('#settings-ui')).toContainText('User Interface Level');
    await expect(TOGGLE_ROW(page)).toHaveCount(0);

    // The control: at Basic the row is there, with its button.
    setSettingInFile('uiLevel', '0');
    await uiTab(page);
    await expect(TOGGLE_ROW(page)).toHaveCount(1);
    await expect(page.locator('input[type=button][value="Change to Advanced UI for 15 Minutes"]')).toHaveCount(1);
  });
});

test('Variables, Recurring Tasks and the If and Set Variable commands are Advanced, not Experimental', async ({ page, request }) => {
  // Feature: cb2da5772.  They were offered only from the Experimental level.
  // The commands' level is fppd's (its command list); the menu is the page's.
  const commands: Array<{ name: string; level?: number }> = await (await request.get('/api/commands')).json();
  for (const name of ['If', 'Set Variable']) {
    expect(commands.find((c) => c.name === name)?.level, name).toBe(1);
  }
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/index.php');
    expect(await menuHasVariables(page)).toBeGreaterThan(0);
    expect(await page.locator('a.dropdown-item[href="recurringtasks.php"]').count()).toBeGreaterThan(0);

    // The control: at Basic neither is in the menu.
    setSettingInFile('uiLevel', '0');
    await page.goto('/index.php');
    expect(await menuHasVariables(page)).toBe(0);
    expect(await page.locator('a.dropdown-item[href="recurringtasks.php"]').count()).toBe(0);
  });
});
