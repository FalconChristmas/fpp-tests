import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

test.skip(!container, 'changes the player settings');

test('a password setting has an eye icon that flips the field between password and text', async ({ page }) => {
  // Regression: 6986279d0.  The tether password was plain text.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/networkconfig.php');
    await page.click('#tab-tethering-tab');
    const field = page.locator('#TetherPSK');
    await expect(field).toHaveAttribute('type', 'password', { timeout: 15_000 });
    const eye = page.locator('#TetherPSKHideShow');
    await eye.click();
    await expect(field).toHaveAttribute('type', 'text');
    await eye.click();
    await expect(field).toHaveAttribute('type', 'password');
  });
});

test('changing the Date Format reloads the page so the new format shows', async ({ page }) => {
  // Regression: 3553777b8.  DateFormat and TimeFormat are marked reloadUI.
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '1');
    await page.goto('/settings.php?tab=Localization');
    const select = page.locator('#DateFormat');
    await expect(select).toBeVisible({ timeout: 15_000 });
    const current = await select.inputValue();
    const other = (await select.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))).find((v) => v !== current)!;
    const reloaded = page.waitForEvent('load', { timeout: 15_000 });
    await select.selectOption(other);
    await reloaded;
  });
});
