import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { clearProxies, PROXY_CONF } from './proxy-controller';
import { SecondPlayer } from './second-player';

// The links the MultiSync table gives a remote: its host name opens the
// remote's own UI, and a modified ("-dirty") build's "Modified" note opens
// that system's Developer settings.  For a remote this player proxies, both
// go through /proxy/<address>/.  The remote is a second real player
// (second-player.ts) and the proxy list is this player's real api/proxies,
// read from the proxy-config.conf the Proxies page writes; the systems list
// is the test's, and status polls get nothing back, so each row shows what
// the list says.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-peer-description';

function system(address: string, hostname: string, version: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version, majorVersion: 10, minorVersion: 0, uuid: `M1-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

// The lines WriteProxyFile() in www/api/controllers/proxies.php writes for a host.
function proxyConf(host: string) {
  return `# D:fpp-tests peer\n` +
    `RewriteRule ^${host}$  ${host}/  [R,L]\n` +
    `RewriteRule ^${host}:([0-9]*)$  http://${host}:$1/  [P,L]\n` +
    `RewriteRule ^${host}:([0-9]*)/(.*)$  http://${host}:$1/$2  [P,L]\n` +
    `RewriteRule ^${host}/(.*)$  http://${host}/$1  [P,L]\n\n`;
}

async function openMultisync(page: Page, peer: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('10.0.0.1', 'fpptests-local', '10.x-master-3-gbbb2222cc-dirty', 1),
    system(peer, 'fpptests-peer', '10.x-master-1-gaaa1111bb-dirty'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const proxies = page.waitForResponse((r) => r.url().endsWith('/api/proxies'));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  await proxies;
}

test("a proxied remote's host name and Modified links open the remote, through /proxy/", async ({ page }) => {
  // Regression: 4e88d77f2.  The host name linked to http://<address>/
  // directly, and api/proxies' entries ({host, description}) were kept
  // whole, so no address was ever found in the proxy list: a remote only
  // reachable through this player could not be opened from the table.
  // Regression: e795eb82d.  "Modified" linked every row, the remotes'
  // included, to this player's own settings.php#settings-developer.
  test.setTimeout(240_000);
  const peer = new SecondPlayer('links').start();
  try {
    peer.sh(`curl -s -X PUT -H 'Content-Type: text/plain' --data '${MARK}' http://127.0.0.1/api/settings/HostDescription`);
    inPlayer('sh', '-c', `printf '%s' '${proxyConf(peer.address).replace(/'/g, "'\\''")}' > ${PROXY_CONF} && apache2ctl graceful`);
    const listed = await (await page.request.get('/api/proxies')).json();
    expect(listed.map((p: any) => p.host)).toContain(peer.address);

    await openMultisync(page, peer.address);
    const remote = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-peer' });
    const local = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-local' });

    const hostLink = remote.locator('a', { hasText: 'fpptests-peer' });
    await expect(hostLink).toHaveAttribute('href', `proxy/${peer.address}/`);
    await expect(hostLink).toHaveAttribute('target', `host_${peer.address}`);

    const remoteModified = remote.getByRole('link', { name: 'Modified' });
    await expect(remoteModified).toHaveAttribute('href', `proxy/${peer.address}/settings.php#settings-developer`);
    await expect(remoteModified).toHaveAttribute('target', `host_${peer.address}`);
    await expect(local.getByRole('link', { name: 'Modified' })).toHaveAttribute('href', 'settings.php#settings-developer');
    // The version itself is shown without the "-dirty".
    const version = remote.locator('table.multiSyncVerboseTable', { hasText: 'FPP:' });
    await expect(version).toContainText('10.x-1Modified');
    await expect(version).not.toContainText('dirty');

    // The receiving end: each link, followed, is the remote's own UI.
    for (const [link, path] of [[hostLink, '/'], [remoteModified, '/settings.php']] as const) {
      const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await popup.waitForLoadState('domcontentloaded');
      expect(new URL(popup.url()).pathname).toBe(`/proxy/${peer.address}${path}`);
      await expect(popup.locator('#header_host')).toHaveAttribute('data-bs-title', MARK);
      await popup.close();
    }
  } finally {
    clearProxies();
    const verdict = peer.stop();
    expect.soft(verdict.ok, verdict.detail).toBe(true);
  }
});
