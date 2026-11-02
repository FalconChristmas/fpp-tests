import { test, expect } from './fixtures';
import { container } from './container';

// Regression: 644a40399 ("Only show button to add FrameBuffer model when a
// FrameBuffer exists").  The Add Pixel Overlay Model dialog always offered
// FrameBuffer, and on a player with no framebuffer it added a model with no
// device to draw on.

test.skip(!container, 'needs the player run-web.sh serves, which has no framebuffer');

test('a player with no framebuffer is not offered a FrameBuffer model', async ({ page }) => {
  await page.goto('/pixeloverlaymodels.php');
  // The precondition: fpp -FB listed no framebuffer for the page.
  expect(await page.evaluate(() => Object.keys((window as any).FBDevices).length)).toBe(0);
  await page.locator('button[value="Add"]').click();
  const dlg = page.locator('#AddPixelOverlayModel');
  await dlg.waitFor({ state: 'visible' });
  // The control: the dialog's other choices are there.
  await expect(dlg.getByRole('button', { name: 'Channel' })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'SubModel' })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'FrameBuffer' })).toHaveCount(0);
});
