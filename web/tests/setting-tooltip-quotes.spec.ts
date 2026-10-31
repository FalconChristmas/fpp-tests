import { test, expect } from './fixtures';

// A setting's help icon (PrintToolTip() in common.php) carries the setting's
// tip from settings.json in a single-quoted data-bs-title attribute, and
// Bootstrap shows it as the icon's tooltip.

test("a setting's tooltip is its whole tip, quotes and all", async ({ page, request }) => {
  // Regression: a6cdccee5 (#2061).  The tip went into the attribute as it
  // was, so its first single quote ended the attribute: UI Level's tooltip
  // stopped at "The default " and the rest became stray attributes.
  const tip: string = (await (await request.get('/settings.json')).json()).settings.uiLevel.tip;
  expect(tip).toContain("'Basic'");
  await page.goto('/settings.php#settings-ui');
  const icon = page.locator('#uiLevel_tip');
  await expect(icon).toBeVisible({ timeout: 15_000 });
  expect(await icon.getAttribute('data-bs-title')).toBe(tip);
  await icon.hover();
  // The tooltip renders the tip as HTML; this one has no markup, and its
  // runs of two spaces collapse.
  await expect(page.locator('.tooltip .tooltip-inner')).toHaveText(tip.replace(/\s+/g, ' '));
});
