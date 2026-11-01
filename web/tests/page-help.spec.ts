import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// Page-specific help: F1 opens help/<page>.php in the help dialog, and the
// Help menu says so when the page has one.

async function settle(page: Page) {
  await page.waitForFunction(() => document.readyState === 'complete' && typeof (window as any).DisplayHelp === 'function');
}

// The help page a press of F1 loads, once the dialog is fully open.
async function f1(page: Page): Promise<string> {
  const loaded = page.waitForResponse((r) => /\/help\/[^?]*\.php/.test(new URL(r.url()).pathname));
  await page.keyboard.press('F1');
  const path = new URL((await loaded).url()).pathname;
  await expect(page.locator('#helpDialog.show')).toBeVisible();
  // A modal ignores a hide asked for while it is still fading in.
  await page.waitForTimeout(500);
  return path;
}

async function closeHelp(page: Page) {
  await page.keyboard.press('F1');
  await expect(page.locator('#helpDialog')).toBeHidden();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
}

test('F1 on Settings shows the help for the tab that is showing', async ({ page }) => {
  // Regression: 895d983be.  DisplayHelp() looked up the tab's help only while
  // helpPage was still 'help/settings.php', and it writes the page it opened
  // back into helpPage, so after the first F1 every tab got the first one's.
  await page.goto('/settings.php#settings-playback');
  await settle(page);
  expect(await f1(page)).toBe('/help/settings-playback.php');
  await closeHelp(page);

  await page.locator('#settings-ui-tab').click();
  await expect(page.locator('#settings-ui-tab')).toHaveClass(/active/);
  expect(await f1(page)).toBe('/help/settings-ui.php');
  await closeHelp(page);

  await page.locator('#settings-logs-tab').click();
  expect(await f1(page)).toBe('/help/settings-logs.php');
});

test('the MQTT help leaves the page it is shown on alone', async ({ page, request }) => {
  // Regression: 895d983be.  help/mqtt.php required config.php without
  // $skipJSsettings, so loading it into the help dialog re-declared the host
  // page's globals (pageName, helpPage, settings) as its own.
  // The MQTT tab is an Advanced one.
  await request.put('/api/settings/uiLevel', { data: '1' });
  await page.goto('/settings.php#settings-mqtt');
  await settle(page);
  expect(await f1(page)).toBe('/help/settings-mqtt.php');
  const integration = page.waitForResponse((r) => new URL(r.url()).pathname === '/help/mqtt.php');
  await page.locator('#helpDialogText a', { hasText: 'MQTT Integration' }).click();
  await integration;
  await expect(page.locator('#helpDialogText')).toContainText('MQTT Topics Published by FPP');
  expect(await page.evaluate(() => (window as any).pageName)).toBe('settings');
  expect(await page.evaluate(() => typeof (window as any).settings['keyBindings'])).toBe('string');
});

test.afterEach(async ({ request }) => {
  await request.put('/api/settings/uiLevel', { data: '0' });
});

test('the Help menu advertises page help where a page has it', async ({ page }) => {
  // Feature: 7eb4b550a, in the final form of d01404a05 and ca0439cbc (the
  // revert of 325ea869a left the Help toggle an <li> inside an <li>, with no
  // link to open the menu).
  await page.goto('/index.php');
  const toggle = page.locator('#navbarDropdownMenuLinkHelp');
  await expect(toggle).toHaveClass(/has-page-help/);
  await expect(toggle.locator('i.fa-question-circle')).toHaveCount(1);
  await toggle.click();
  await expect(page.locator('a.help-for-page')).toBeVisible();
  // Its entry opens this page's help, as F1 does.
  await page.locator('a.help-for-page').click();
  await expect(page.locator('#helpDialog')).toBeVisible();
  await page.goto('/index.php?fpp-tests=menu');
  await expect(toggle).toHaveClass(/has-page-help/);

  // effects.php has no help/effects.php.
  expect(inPlayer('sh', '-c', 'test -e /opt/fpp/www/help/effects.php && echo yes || echo no').trim()).toBe('no');
  await page.goto('/effects.php');
  await expect(toggle).not.toHaveClass(/has-page-help/);
  await toggle.click();
  await expect(page.locator('#navbarDropdownMenuLinkHelp + .dropdown-menu')).toBeVisible();
  await expect(page.locator('a.help-for-page')).toHaveCount(0);
});

test.describe('a plugin page', () => {
  test.skip(!container, 'seeds a plugin inside the run-web.sh container');
  const DIR = '/home/fpp/media/plugins/fpp-tests-help';

  test.beforeAll(() => {
    inPlayer('sh', '-c', `mkdir -p ${DIR}/help &&
      echo '{"name":"fpp-tests-help","repoName":"fpp-tests-help"}' > ${DIR}/pluginInfo.json &&
      echo '<div id="fppTestsPluginPage">plugin page</div>' > ${DIR}/withhelp.php &&
      echo '<div id="fppTestsPluginPage">plugin page</div>' > ${DIR}/nohelp.php &&
      echo '<p id="fppTestsPluginHelp">plugin page help</p>' > ${DIR}/help/withhelp.php`);
  });

  test.afterAll(() => {
    inPlayer('rm', '-rf', DIR);
  });

  test('with help of its own gets "Help for This Page"', async ({ page }) => {
    // Regression: 0b319fee3.  menu.inc looked for www/help/plugin.php, so no
    // plugin page ever got the entry, whatever help it shipped.
    await page.goto('/plugin.php?plugin=fpp-tests-help&page=withhelp.php');
    await expect(page.locator('#fppTestsPluginPage')).toBeVisible();
    await expect(page.locator('#navbarDropdownMenuLinkHelp')).toHaveClass(/has-page-help/);
    await page.locator('#navbarDropdownMenuLinkHelp').click();
    await page.locator('a.help-for-page').click();
    await expect(page.locator('#fppTestsPluginHelp')).toBeVisible();

    await page.goto('/plugin.php?plugin=fpp-tests-help&page=nohelp.php');
    await expect(page.locator('#fppTestsPluginPage')).toBeVisible();
    await expect(page.locator('#navbarDropdownMenuLinkHelp')).not.toHaveClass(/has-page-help/);
    await expect(page.locator('a.help-for-page')).toHaveCount(0);
  });
});
