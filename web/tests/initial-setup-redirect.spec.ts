import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// A page opened before setup is finished (a bookmark, say) sends the browser to
// the wizard and finishing the wizard brings it back to that page.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a page opened before setup is finished goes to the wizard and back to that page', async ({ page }) => {
  // Regression: fe8373d55.  Only index.php checked whether setup was done, so
  // a bookmark to any other page showed that page half-configured; the check
  // moved into menuHead.inc with ?redirect=, and the wizard's finish follows
  // it instead of always going to index.php.
  // (Today the gate keys off initialSetup-02 and the redirect is validated;
  // see request-input-escaped.spec.ts for what it refuses.)
  test.setTimeout(180_000);
  setSettingInFile('initialSetup-02', '0');
  page.on('dialog', (d) => d.accept());
  await page.goto('/settings.php');
  await expect(page).toHaveURL(/initialSetup\.php\?redirect=settings\.php$/, { timeout: 30_000 });

  await expect(page.locator('.setupStep[data-step="1"]')).toBeVisible();
  await page.selectOption('#LegalJurisdiction', 'US');
  for (const step of [2, 3, 4]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
  await page.selectOption('#passwordEnable', '0');
  await page.click('#finishSetupBtn');
  await expect(page).toHaveURL(/\/settings\.php$/, { timeout: 60_000 });
  expect(settingInFile('initialSetup-02')).toBe('1');
});
