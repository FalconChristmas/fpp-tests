import { expect, test } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';

async function gotoPage(page: Page, path: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(path, { waitUntil: 'commit', timeout: 5_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 4) {
        break;
      }
      await page.waitForTimeout(750);
    }
  }

  throw lastError;
}

function getSystemTheme(testInfo: TestInfo): 'light' | 'dark' {
  return testInfo.project.name.includes('dark') ? 'dark' : 'light';
}

async function openThemeOverrideSetting(page: Page) {
  await gotoPage(page, '/settings.php');
  await page.locator('#settingsManagerTabs').first().waitFor({ state: 'visible', timeout: 10_000 });

  const uiTab = page.locator('#settings-ui-tab').first();
  await uiTab.click();

  await page.waitForFunction(() => {
    const tab = document.querySelector('#settings-ui-tab');
    const pane = document.querySelector('#settings-ui');

    return Boolean(
      tab &&
      pane &&
      tab.classList.contains('active') &&
      pane.classList.contains('active')
    );
  });

  await page.locator('#settings-ui').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('#themeOverride').first().waitFor({ state: 'visible', timeout: 10_000 });
}

async function setThemeOverrideAndVerify(page: Page, overrideValue: '' | 'light' | 'dark', expectedTheme: 'light' | 'dark') {
  await page.locator('#themeOverride').selectOption(overrideValue);

  await page.waitForFunction(
    expected => {
      const html = document.documentElement;
      return (
        html.getAttribute('data-bs-theme') === expected &&
        html.style.colorScheme === expected
      );
    },
    expectedTheme
  );

  await expect(page.locator('#themeOverride')).toHaveValue(overrideValue);
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', expectedTheme);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
    .toBe(expectedTheme);
}

test('Theme Override - dark forces dark mode', async ({ page }) => {
  await openThemeOverrideSetting(page);
  await setThemeOverrideAndVerify(page, 'dark', 'dark');
});

test('Theme Override - light forces light mode', async ({ page }) => {
  await openThemeOverrideSetting(page);
  await setThemeOverrideAndVerify(page, 'light', 'light');
});

test('Theme Override - system default follows browser scheme', async ({ page }, testInfo) => {
  await openThemeOverrideSetting(page);
  await setThemeOverrideAndVerify(page, '', getSystemTheme(testInfo));
});
