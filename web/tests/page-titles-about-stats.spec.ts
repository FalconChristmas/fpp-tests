import { test, expect } from './fixtures';

// The About and System Health pages name themselves in the browser tab: their
// own <title> carries the host's title, as the other pages' do.

test('the About page has a title', async ({ page }) => {
  // Regression: 989819183.  about.php wrote no <title> of its own, so the
  // browser tab showed the bare address instead of the host's title.
  await page.goto('/about.php');
  const title = await page.title();
  expect(title.trim().length, 'the About page has no <title>').toBeGreaterThan(0);
  expect(title).not.toContain('$pageTitle');
  // The control: the same title the other pages carry.
  await page.goto('/backup.php');
  expect(title).toBe(await page.title());
});

test('the System Health page has a title', async ({ page }) => {
  // Regression: a3721cd84.  system-stats.php wrote no <title>, so the
  // browser tab showed the bare address instead of the host's title.
  await page.goto('/system-stats.php');
  const title = await page.title();
  expect(title.trim().length, 'the System Health page has no <title>').toBeGreaterThan(0);
  expect(title).not.toContain('$pageTitle');
  // The control: the same title the other pages carry.
  await page.goto('/backup.php');
  expect(title).toBe(await page.title());
});
