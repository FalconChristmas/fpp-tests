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

test.describe('failed requests', () => {
  // A path the player answers with 404.
  const MISSING = '/api/fpp-tests-no-such-endpoint';

  test('a failed request to the player fails the test', async ({ page }) => {
    test.fail(true, 'the guard throws "1 failed request(s)" after the test');
    await page.goto('/about.php');
    expect(await page.evaluate((u) => fetch(u).then((r) => r.status), MISSING)).toBe(404);
  });

  test("an error a test's own route answers with does not", async ({ page }) => {
    await page.route(`**${MISSING}`, (route) => route.fulfill({ status: 500, body: 'fpp-tests stub' }));
    await page.goto('/about.php');
    expect(await page.evaluate((u) => fetch(u).then((r) => r.status), MISSING)).toBe(500);
  });

  test("the player's own error passed on by a route still fails the test", async ({ page }) => {
    test.fail(true, 'the guard throws: the 404 is the player\'s, not the route\'s');
    await page.route(`**${MISSING}`, async (route) => route.fulfill({ response: await route.fetch() }));
    await page.goto('/about.php');
    expect(await page.evaluate((u) => fetch(u).then((r) => r.status), MISSING)).toBe(404);
  });

  test.describe('allowed by pattern', () => {
    test.use({ allowFailedRequests: [/fpp-tests-no-such-endpoint 404/] });
    test('an expected failure the test names does not', async ({ page }) => {
      await page.goto('/about.php');
      expect(await page.evaluate((u) => fetch(u).then((r) => r.status), MISSING)).toBe(404);
    });
  });
});
