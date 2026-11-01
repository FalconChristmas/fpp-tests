import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { clearProxies, PROXY_CONF } from './proxy-controller';

// The MultiSync page's "Add as Proxy" action: the checked systems are added
// to this player's proxy list (api/proxies, the Proxies page's list), which
// writes the Apache rewrite rules that make /proxy/<host>/ reach them.

test.skip(!container, 'writes the proxy configuration inside the run-web.sh container');

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';

function system(address: string, hostname: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: `M1-fpptests-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

test.afterEach(() => clearProxies());

test('Add as Proxy puts the checked system on the proxy list once', async ({ page, request }) => {
  // Regression: 3fa986fb0.  The action was added, and AddProxy() tested
  // in_array() the wrong way round, so a host was only ever "added" when it
  // was already listed.  Adding it again must not list it twice.
  clearProxies();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system(LOCAL, 'local', 1), system(REMOTE, 'remote'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'remote' }).last();
  for (let i = 0; i < 2; i++) {
    await row.locator('input.remoteCheckbox').check();
    await page.selectOption('#multiAction', 'addProxy');
    const added = page.waitForResponse((r) => r.url().endsWith(`/api/proxies/${REMOTE}`) && r.request().method() === 'POST');
    await page.locator('#performActionButton').click();
    expect((await added).ok()).toBe(true);
  }
  const listed = (await (await request.get('/api/proxies')).json()).map((p: any) => p.host);
  expect(listed).toEqual([REMOTE]);
  // The receiving end: Apache's rewrite rules for it, written once.
  const conf = inPlayer('cat', PROXY_CONF);
  expect(conf.split(`RewriteRule ^${REMOTE}/(.*)`).length - 1).toBe(1);
  inPlayer('apache2ctl', 'configtest');
});
