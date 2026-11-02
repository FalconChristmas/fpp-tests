import { test, expect } from './fixtures';

// PrintSettingSelect (common.php) draws every select a settings page has.

test('settings selects carry Bootstrap\'s form-select class, a parent setting\'s keeps parentSetting', async ({ page }) => {
  // Regression: 0c69bb4ed.  The selects were bare <select>s, which Bootstrap
  // does not size to the form column, so on a narrow screen a long option
  // pushed the form wider than the page.
  await page.goto('/settings.php?tab=AV');
  const backend = page.locator('select#MediaBackend');
  await expect(backend).toHaveClass(/\bform-select\b/);
  // MediaBackend has children: the class parentSetting is how the page finds
  // the settings that show and hide with it.
  await expect(backend).toHaveClass(/\bparentSetting\b/);
  const plain = page.locator('select#AudioFormat');
  if (await plain.count()) await expect(plain).toHaveClass(/\bform-select\b/);
  // Every select a setting drew (they carry the setting's own change handler).
  const bare = await page.locator('select[id][onchange]').evaluateAll(
    (els) => els.filter((e) => !e.classList.contains('form-select')).map((e) => e.id));
  expect(bare, 'settings selects without form-select').toEqual([]);
});
