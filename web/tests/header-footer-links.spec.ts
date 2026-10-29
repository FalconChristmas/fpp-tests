import { test, expect } from './fixtures';

// Small fixed parts of the pages: the platform logo in the header, linking
// to the platform's site, and the Credits page's copyright line.

test("the header's platform logo opens its site without handing it this page", async ({ page, context }) => {
  // Regression: 9d27cf783.  The logo link opened a new tab
  // (target=_blank) with no rel, so the platform's site got this player's
  // address as the Referer, and window.opener with it.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/index.php');
  const link = page.locator('.headerRight a.platformLogoLink');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /\bnoopener\b/);
  await expect(link).toHaveAttribute('rel', /\bnoreferrer\b/);

  // The receiving end: the platform's site (answered by the test) gets no
  // Referer, and the new tab has no opener.
  const href = (await link.getAttribute('href'))!;
  const site = new URL(href).origin;
  let referer: string | undefined = 'not asked';
  await context.route(`${site}/**`, (route) => {
    referer = route.request().headers()['referer'];
    return route.fulfill({ contentType: 'text/html', body: '<html><body>fpp-tests platform site</body></html>' });
  });
  const opened = context.waitForEvent('page');
  await link.click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(referer).toBeUndefined();
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
});

test('the Credits page copyright runs to the current year', async ({ page }) => {
  // Regression: 94963b4e8.  The years were written into the page
  // ("2013-2024") and went stale every January.
  await page.goto('/credits.php');
  const year = new Date().getFullYear();
  await expect(page.locator('small', { hasText: 'Copyright' })).toHaveText(`Copyright © 2013-${year}`);
});
