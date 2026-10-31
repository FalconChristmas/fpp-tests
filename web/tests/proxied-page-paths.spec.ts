import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { clearProxies, PROXY_CONF } from './proxy-controller';
import { SecondPlayer } from './second-player';

// Another player's pages seen through this one's /proxy/<address>/: what
// they link to and load must stay under that prefix, or it lands on this
// player instead.  The remote is a second real player (second-player.ts).

test.skip(!container, 'puts a second player next to the run-web.sh container');

// The lines WriteProxyFile() in www/api/controllers/proxies.php writes for a host.
function proxyConf(host: string) {
  return `# D:fpp-tests peer\n` +
    `RewriteRule ^${host}$  ${host}/  [R,L]\n` +
    `RewriteRule ^${host}:([0-9]*)$  http://${host}:$1/  [P,L]\n` +
    `RewriteRule ^${host}:([0-9]*)/(.*)$  http://${host}:$1/$2  [P,L]\n` +
    `RewriteRule ^${host}/(.*)$  http://${host}/$1  [P,L]\n\n`;
}

test("a proxied player's header logo and select arrows stay under its /proxy/ path", async ({ page, baseURL }) => {
  // Regression: f1d08371d.  The header logo linked to "/" and the select
  // arrow's image was url(/images/...), so through /proxy/<address>/ the
  // logo opened the proxying player's own status page and the arrows were
  // fetched from it.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('paths').start();
  try {
    inPlayer('sh', '-c', `printf '%s' '${proxyConf(peer.address).replace(/'/g, "'\\''")}' > ${PROXY_CONF} && apache2ctl graceful`);
    const prefix = `/proxy/${peer.address}/`;
    await page.goto(`${prefix}settings.php`);
    const logo = page.locator('.header .fppBrand a').first();
    await expect(logo).toHaveCount(1);
    expect(new URL(await logo.evaluate((a: HTMLAnchorElement) => a.href)).pathname, 'the logo leaves the proxied player').toBe(`${prefix}index.php`);
    const select = page.locator('.pageContent select').first();
    await expect(select).toBeAttached();
    const arrow = await select.evaluate((s) => getComputedStyle(s).backgroundImage);
    const url = /url\("?([^")]+)"?\)/.exec(arrow)?.[1] ?? '';
    expect(url, arrow).toContain('chevron-down-grey.svg');
    expect(new URL(url, baseURL).pathname, 'the arrow comes from the proxying player').toBe(`${prefix}images/redesign/chevron-down-grey.svg`);
    // The receiving end: followed, the logo is the remote's own status page.
    await logo.click();
    await page.waitForLoadState('domcontentloaded');
    expect(new URL(page.url()).pathname).toBe(`${prefix}index.php`);
  } finally {
    clearProxies();
    const verdict = peer.stop();
    expect.soft(verdict.ok, verdict.detail).toBe(true);
  }
});
