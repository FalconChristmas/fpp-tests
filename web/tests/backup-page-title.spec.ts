import { test, expect } from './fixtures';

// Regression: 03401e4e2. The Backups page wrote its <title> as the literal
// text "$pageTitle" (the tag held the variable name, not a PHP echo), so the
// browser tab read "$pageTitle" instead of the host's title.
test('the Backups page title is the host title, not the variable name', async ({ page }) => {
  await page.goto('/about.php');
  const expected = await page.title();
  expect(expected.length).toBeGreaterThan(0);
  await page.goto('/backup.php');
  const title = await page.title();
  expect(title).not.toContain('$pageTitle');
  expect(title).toBe(expected);
});
