import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, snapshotSettings } from './settings-file';

// fpp.js's SetSetting(): the "<key> setting saved." notice a save raises, and
// the callers that ask for none.

test.skip(!container, 'reads the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('a SetSetting() caller can save a setting without the "setting saved" notice', async ({ page }) => {
  // Regression: dbf822435.  Places that save a setting the user did not change
  // (background writes) have no use for the notice; SetSetting() got a
  // hideChange argument for them.  Without the argument the notice shows as
  // before.
  await page.goto('/index.php');
  await page.waitForFunction(() => typeof (window as any).SetSetting === 'function');
  const notices = page.locator('.jGrowl-notification');

  // Both saves go in one go; the queue runs them in order, so by the time the
  // second one's notice shows, the first one's would have.
  await page.evaluate(() => {
    (window as any).SetSetting('fppTestsHidden', '1', 0, 0, true);
    (window as any).SetSetting('fppTestsShown', '1', 0, 0);
  });
  // The control: a normal save raises the notice.
  await expect(notices.filter({ hasText: 'fppTestsShown setting saved.' })).toHaveCount(1, { timeout: 10_000 });
  // Both were written the same way, and only one has a notice.
  expect(settingInFile('fppTestsHidden')).toBe('1');
  expect(settingInFile('fppTestsShown')).toBe('1');
  // Counted once: toHaveCount(0) would wait for a notice to fade and pass.
  expect(await notices.filter({ hasText: 'fppTestsHidden' }).count()).toBe(0);
});
