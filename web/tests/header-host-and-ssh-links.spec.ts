import { test, expect } from './fixtures';

// Two links in the header: the host name, and the Help menu's SSH Shell.

test('the host name in the header goes to the status page', async ({ page }) => {
  // Regression: 1cc8bdf58 (#1667).  It linked to the host settings, and only
  // at the Developer UI level or off a desktop browser; on a phone, where the
  // host name stands in for the FPP logo, getting to the status page took
  // three taps through the menu.
  await page.goto('/settings.php');
  const host = page.locator('#header_host a');
  await expect(host).toHaveAttribute('href', 'index.php');
  await host.click();
  await expect(page).toHaveURL(/\/index\.php$/);
  await expect(page.locator('#programControl')).toBeAttached();
});

test('the SSH Shell link goes through the proxy the page was reached through', async ({ page }) => {
  // Regression: e874ce1fb (#1558).  The link was always to port 4200 of the
  // host the browser asked for, which behind a proxy is the proxy itself.
  // Reached through one (X-Forwarded-Host), it goes to the proxy's
  // /proxy/<this player's address>:4200.
  const ssh = page.locator('a', { hasText: 'SSH Shell' });
  await page.goto('/index.php');
  const host = new URL(page.url()).hostname;
  await expect(ssh).toHaveAttribute('href', new RegExp(`^http://${host.replace(/\./g, '\\.')}:4200$`));

  await page.setExtraHTTPHeaders({ 'X-Forwarded-Host': 'proxy.example.test:8443' });
  await page.goto('/index.php?proxied');
  // SERVER_ADDR: the address the player itself answered on.
  await expect(ssh).toHaveAttribute('href', /^http:\/\/proxy\.example\.test:8443\/proxy\/[0-9a-f.:]+:4200$/);
});

test('the SSH Shell link is to port 4200 of a player reached on another port', async ({ page }) => {
  // Regression: dccc486d3 (found checking e874ce1fb).  The link was
  // "http://" + HTTP_HOST + ":4200", and HTTP_HOST carries the port the
  // browser used when it is not 80, so a player reached on, say, :8080 (a
  // port forward, a container) got "http://host:8080:4200", which is not a
  // URL a browser can open.
  await page.goto('/index.php');
  const url = new URL(page.url());
  test.skip(url.port === '', 'reached on port 80');
  await expect(page.locator('a', { hasText: 'SSH Shell' })).toHaveAttribute('href', `http://${url.hostname}:4200`, { timeout: 5_000 });
});
