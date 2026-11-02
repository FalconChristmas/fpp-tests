import { test, expect } from './fixtures';

// The Display Testing page (testing.php) is one set of tabs; each tab's pane
// sits beside the others.

test('the Display Testing tab panes are siblings, not nested in one another', async ({ page }) => {
  // Regression: 8a5b739e8.  The channel testing pane was missing two closing
  // tags, so the DMX and sequence panes were drawn inside it: hidden with it
  // and laid out as part of it.
  await page.goto('/testing.php');
  await expect(page.locator('#testModeEnabled')).toBeAttached({ timeout: 15_000 });
  const parents = await page.evaluate(() => ['tab-channels', 'tab-dmx', 'tab-sequence'].map((id) => {
    const e = document.getElementById(id);
    return e && e.parentElement ? e.parentElement.className + '|' + e.parentElement.id : null;
  }));
  expect(parents[0], 'the control: the channel testing pane').not.toBeNull();
  expect(parents[1]).toBe(parents[0]);
  expect(parents[2]).toBe(parents[0]);
  // And the DMX tab shows its pane.
  await page.locator('#tab-dmx-tab').click();
  await expect(page.locator('#tab-dmx')).toBeVisible();
  await expect(page.locator('#tab-channels')).toBeHidden();
});
