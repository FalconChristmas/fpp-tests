import { test, expect } from './fixtures';

// Pixel Overlay Models: "Delete xLights Generated" removes the rows flagged
// as made by xLights and keeps the hand-made models (Feature: 927de9f2f).
// The player starts with one xLights model ("fpp-tests-matrix", from the
// run-web.sh container's seeded model-overlays.json); the test adds a model
// by hand on the page.

test('Delete xLights Generated removes the xLights models and keeps the others', async ({ page }) => {
  await page.goto('/pixeloverlaymodels.php');
  const names = page.locator('#channelMemMaps tbody tr input.blk');
  await expect(names).toHaveCount(1);
  await expect(names.first()).toHaveValue('fpp-tests-matrix');
  await expect(page.locator('#channelMemMaps tbody tr input.xlights').first()).toBeChecked();

  await page.locator('button[value=Add]').click();
  await page.locator('#AddPixelOverlayModel').getByRole('button', { name: 'Channel' }).click();
  await expect(names).toHaveCount(2);
  await page.locator('#btnDeleteXlights').click();
  await expect(names).toHaveCount(1);
  expect(await names.first().inputValue()).not.toBe('fpp-tests-matrix');
});
