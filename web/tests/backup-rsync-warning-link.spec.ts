import { test, expect } from './fixtures';

// Regression: 820eab6a2 ("fix link to enable rsync from backups pages").
// When the File Copy section can't list a remote host's drives it asks the
// host whether its rsync server is enabled, and if not, warns and links to the
// host's settings page.  The link went to settings.php#settings-system, but
// "Enable rsync" (Service_rsync) is in OS Services on the Services tab, so the
// link opened a tab without it.  The remote's answers are stand-ins; the
// receiving end is the settings page the link names (every player's is the
// same page, so this player's is opened), which has to show the setting.

// Also ce4853c9f: the warning itself, next to the host, when the remote's
// Service_rsync is off (red with the warning never added).
const HOST = '192.0.2.11'; // TEST-NET-1: never a real player

test("the File Copy rsync warning links to the settings tab with \"Enable rsync\"", async ({ page }) => {
  // Settings writes are swallowed so the player's own backup settings are left alone.
  await page.route((u) => u.pathname.includes('/api/settings/') && !u.searchParams.has('ip'),
    (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
  await page.route((u) => u.pathname.endsWith('/api/backups/devices') && !u.searchParams.has('ip'),
    (route) => route.fulfill({ json: [] }));
  await page.route((u) => u.searchParams.get('ip') === HOST && u.pathname.endsWith('/api/backups/devices'),
    (route) => route.fulfill({ status: 502, body: 'unreachable' }));
  await page.route((u) => u.searchParams.get('ip') === HOST && u.pathname.endsWith('/api/settings/Service_rsync'),
    (route) => route.fulfill({ json: { name: 'Service_rsync', value: '0' } }));

  // Any other player's answers (the player's own address is on the host list)
  // would redraw the warning for that host, after this host's, when the
  // direction change checks the host selected first.  They get nothing.
  await page.route((u) => u.searchParams.has('ip') && u.searchParams.get('ip') !== HOST && u.pathname.includes('/api/'),
    (route) => route.abort());

  await page.goto('/backup.php');
  await page.click('#backups-fileCopy-tab');
  // This host is the only one on the list, so picking TOREMOTE checks it and
  // no other host's check can redraw the warning.
  await page.evaluate((host) => {
    const sel = document.getElementById('backup.Host') as HTMLSelectElement;
    sel.innerHTML = '';
    sel.add(new Option(host, host));
    sel.value = host;
  }, HOST);
  await page.selectOption('#backup\\.Direction', 'TOREMOTE');

  const link = page.locator(`.host_rsyncd_warning a[href*="//${HOST}/"]`);
  await expect(link).toHaveCount(1, { timeout: 15_000 });
  const href = new URL((await link.getAttribute('href'))!);
  expect(href.host).toBe(HOST);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto(`/settings.php?fpp-tests=${Date.now()}${href.hash}`);
  await expect(page.locator('#Service_rsync'), `${href.hash} does not show "Enable rsync"`).toBeVisible({ timeout: 15_000 });
});
