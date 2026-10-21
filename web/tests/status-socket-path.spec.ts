import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The status WebSocket (fppdws) is opened by js/fpp.js at a URL built in the
// browser, so it has to work out for itself where the site's root is.

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

async function socketUrl(page: Page, path: string): Promise<string> {
  const opened = page.waitForEvent('websocket', { timeout: 15_000 });
  await page.goto(path);
  return (await opened).url();
}

test('a page in a subdirectory opens the socket at the root', async ({ page, baseURL }) => {
  // Regression: 321f8a5fe.  The prefix was taken from the page's own path,
  // so a page in a subdirectory (the API docs, /wled/) asked for
  // ws://<host>/api/fppdws, which nothing serves, and retried it forever.
  // The subdirectory page is played by the browser: index.php's markup, served
  // at /fpp-tests-sub/page.php with its includes pointed up a level.
  const origin = new URL(baseURL!).origin;
  await page.route(`${origin}/fpp-tests-sub/page.php`, async (route) => {
    try {
      const response = await route.fetch({ url: `${origin}/index.php` });
      const body = (await response.text()).replace(/\b(src|href)=(["'])(?![a-z]+:|\/|#)/gi, '$1=$2../');
      await route.fulfill({ response, body });
    } catch {
      // the test is already over
    }
  });
  const host = new URL(baseURL!).host;
  expect(await socketUrl(page, '/fpp-tests-sub/page.php')).toBe(`ws://${host}/fppdws`);
  expect(await socketUrl(page, '/index.php')).toBe(`ws://${host}/fppdws`);
});

test('a site served under a path prefix opens the socket under that prefix', async ({ page, baseURL }) => {
  // Regression: cfe9b1582.  Only FPP's own /proxy/<host>/ layout kept its
  // prefix; any other reverse proxy serving the UI under a prefix got
  // ws://<host>/fppdws, which reaches that host's fppd or nothing.  The
  // prefix is played here by the browser: /fpp-tests-prefix/<x> is answered
  // with the player's /<x>.
  const origin = new URL(baseURL!).origin;
  await page.route(`${origin}/fpp-tests-prefix/**`, async (route) => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: origin + url.pathname.replace(/^\/fpp-tests-prefix/, '') + url.search });
      await route.fulfill({ response });
    } catch {
      // the test is already over
    }
  });
  const host = new URL(baseURL!).host;
  expect(await socketUrl(page, '/fpp-tests-prefix/index.php')).toBe(`ws://${host}/fpp-tests-prefix/fppdws`);
});
