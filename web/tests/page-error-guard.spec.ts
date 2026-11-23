import { test, expect } from './fixtures';

// The page fixture's guard (fixtures.ts): a test fails on an uncaught page
// error it did not look for, unless the page lost a script on the way.

test('an uncaught page error fails the test', async ({ page }) => {
  test.fail(true, 'the guard throws "1 uncaught page error(s)" after the test');
  await page.goto('/about.php');
  await page.evaluate(() => { setTimeout(() => { throw new Error('fpp-tests guard check'); }); });
  await expect.poll(() => page.evaluate(() => 1)).toBe(1);
  await page.waitForTimeout(200);
});

test('page errors from a lost script do not fail the test', async ({ page }) => {
  // fpp.js answers nothing, so the page's own scripts throw for want of it.
  await page.route('**/js/fpp.js*', (route) => route.abort('connectionreset'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/about.php');
  await expect.poll(() => errors.length).toBeGreaterThan(0);
});
