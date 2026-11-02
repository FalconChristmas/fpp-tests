import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// A number setting in settings.json may carry a "step" (eFuse Retry Time
// Interval: 100 ms), which the rendered <input type=number> has to pass on.

test.skip(!container, 'sets the UI level inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); setSettingInFile('uiLevel', '1'); });
test.afterEach(() => restoreSettings());

test('a number setting with its own step steps by it, and one without steps by 1', async ({ page }) => {
  // Regression: d1b5609b6.  PrintSettingTextSaved left the step off the
  // input, so the spinner stepped a setting that moves in hundreds by 1.
  await page.goto('/settings.php?tab=Output');
  const efuse = page.locator('#eFuseRetryInterval');
  await expect(efuse).toBeAttached({ timeout: 15_000 });
  await expect(efuse).toHaveAttribute('step', '100');
  // The receiving end is the browser's own spinner.
  const stepped = await efuse.evaluate((el: HTMLInputElement) => {
    el.value = '200';
    el.stepUp();
    return el.value;
  });
  expect(stepped).toBe('300');
  // The control: a setting whose step is the default 1 gets no attribute.
  const count = page.locator('#eFuseRetryCount');
  await expect(count).toBeAttached();
  expect(await count.getAttribute('step')).toBeNull();
});
