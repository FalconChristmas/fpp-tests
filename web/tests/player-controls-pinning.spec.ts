import { test, expect } from './fixtures';

// The status page's player controls, which are pinned under the header as the
// page scrolls.

test('the player controls are not pinned while the player section is hidden', async ({ page }) => {
  // Regression: 1afd8e8fe.  The controls were pinned (and re-pinned whenever
  // the player section's visibility changed) while that section was hidden --
  // at page load until the first status answer picks the mode, and whenever
  // the page leaves player mode.  Measured hidden they sit at 0,0, so the pin
  // fixed them to the top left corner of the window, and that is where they
  // showed (in Firefox, for a frame) when the section appeared.  Hiding the
  // section the way the page does on a mode change takes the same path.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
  const section = page.locator('#playerModeInfo');
  await expect(section).toBeVisible({ timeout: 15_000 });
  // Pinned, the controls leave a clone of themselves (same id) in their place.
  const controls = page.locator('#controlsSection:not(.Zebra_Pin_Clone)');
  const clone = page.locator('#controlsSection.Zebra_Pin_Clone');
  const position = () => controls.evaluate((el) => getComputedStyle(el).position);
  // The control: shown and unscrolled, the controls sit in their place.
  await expect.poll(position).not.toBe('fixed');
  await expect(clone).toHaveCount(0);

  await page.evaluate(() => (window as any).$('#playerModeInfo').hide());
  await expect(section).toBeHidden();
  // The page reacts to the visibility change through an observer.
  await page.waitForTimeout(500);
  expect(await position(), 'the controls while the player section is hidden').not.toBe('fixed');
  await expect(clone, 'a pinned clone while the player section is hidden').toHaveCount(0);

  await page.evaluate(() => (window as any).$('#playerModeInfo').show());
  await expect(section).toBeVisible();
  await expect.poll(position).not.toBe('fixed');
  const box = await controls.boundingBox();
  const sectionBox = await section.boundingBox();
  expect(box && sectionBox && box.y >= sectionBox.y, JSON.stringify({ box, sectionBox })).toBe(true);
});
