import { test, expect } from './fixtures';

// The tooltips SetupToolTips() in fpp.js gives every titled element.

test('a tooltip held up by focus goes away a few seconds after the mouse leaves', async ({ page }) => {
  // Regression: 38061b42f.  Bootstrap shows a tooltip on hover and on
  // focus, and keeps it while either holds: once the control had the focus
  // (clicked, or tabbed to), its tooltip stayed over the page after the
  // mouse had gone, until the focus moved.  It is hidden 3 s after the
  // mouse leaves now, unless the mouse has come back.
  await page.goto('/index.php');
  // The master volume slider (focused from here, not clicked, so the
  // volume is left alone).
  const slider = page.locator('#slider');
  await expect(slider).toBeVisible();
  const tip = page.locator('.tooltip', { hasText: 'Master volume' });
  await slider.hover();
  await expect(tip).toBeVisible();
  await slider.focus();
  await page.mouse.move(5, 5);
  // The control: the focus keeps it up once the mouse has left.
  await page.waitForTimeout(1_000);
  await expect(tip).toBeVisible();
  await expect(slider).toBeFocused();
  // Gone within the 3 s, not held until the focus moves.
  await expect(tip).toBeHidden({ timeout: 4_000 });
  await expect(slider).toBeFocused();
});
