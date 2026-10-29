import { test, expect } from './fixtures';
import http from 'http';
import { container, inPlayer, playerAddress } from './container';
import { writeFile } from './pw-helpers';
import {
  MEDIA, PROXY_CONF, apacheSystemctl, clearProxies, noLeases, offerLeases, realSystemctl, startController,
  stopController,
} from './proxy-controller';

// What /proxy/<host>/ reaches: the rules in etc/apache2.site, the proxies the
// Proxies page saves (www/api/controllers/proxies.php writes them to
// config/proxy-config.conf) and the DHCP server's subnet (fppinit writes
// config/dhcp-proxy-config.conf).  The receiving end is the real thing each
// time: the player's Apache, reloaded the way the API or fppinit reloads it,
// forwarding to a controller on the player's network (proxy-controller.ts).

test.skip(!container, 'puts a controller next to the run-web.sh container');

let ctl = '';
test.beforeAll(() => {
  ctl = startController();
});
test.afterAll(() => {
  stopController();
  noLeases();
  realSystemctl();
  clearProxies();
});
test.beforeEach(() => {
  noLeases();
  realSystemctl();
  clearProxies();
});

// From outside the player on a connection of its own, redirects not followed.
function get(path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// What /proxy/<path> gets back: the controller's answer, or Apache's status.
async function reached(path: string): Promise<string> {
  const r = await get(`/proxy/${path}`);
  return r.status === 200 ? r.body : `HTTP ${r.status}`;
}

async function save(request: any, proxies: Array<{ host: string; description?: string }>) {
  const r = await request.post('/api/proxies', { data: proxies });
  expect(r.status(), await r.text()).toBe(200);
  return r;
}

test('a controller\'s API on the private network is reached through /proxy unconfigured', async () => {
  // Regression: 52f75a766 ("refactor proxy apache rules to move away from
  // .htaccess and fix broken access").  The /proxy rules lived in an
  // .htaccess that "AllowOverride None" never read, so nothing under /proxy
  // was proxied.  The site config now proxies /api of any private address.
  expect(await reached(`${ctl}/api/fpp-tests`)).toBe('controller:80:/api/fpp-tests');
  // The rest of an unconfigured device stays shut.
  expect(await reached(`${ctl}/fpp-tests`)).toBe('HTTP 404');
});

test('/proxy/<address> with no slash is sent to /proxy/<address>/, configured or not', async ({ request }) => {
  // Regression: 52f75a766 added the redirect; bae9ea1ba ("Move the last "/"
  // check before the configured proxies as well") put it ahead of the saved
  // proxies, whose own "^<host>$ <host>/ [R]" rule redirected to the
  // directory's file path (/opt/fpp/www/proxy/<host>/).
  let r = await get(`/proxy/${ctl}`);
  expect(r.status).toBe(301);
  expect(new URL(r.headers.location!, 'http://x').pathname).toBe(`/proxy/${ctl}/`);
  await save(request, [{ host: ctl }]);
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(() => reached(`${ctl}/fpp-tests`)).toBe('controller:80:/fpp-tests');
  r = await get(`/proxy/${ctl}`);
  expect(r.status).toBe(301);
  expect(new URL(r.headers.location!, 'http://x').pathname).toBe(`/proxy/${ctl}/`);
});

test('a saved proxy reaches the controller\'s other ports too', async ({ request }) => {
  // Regression: bde95aa80 ("Configured proxies can also proxy stuff on other
  // ports (like 4200 for shellinabox)"): only port 80 was proxied.
  await save(request, [{ host: ctl }]);
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(() => reached(`${ctl}/fpp-tests`)).toBe('controller:80:/fpp-tests');
  expect(await reached(`${ctl}:8080/fpp-tests`)).toBe('controller:8080:/fpp-tests');
  expect(await reached(`${ctl}:8080`)).toBe('controller:8080:/');
});

test('saving proxies answers JSON, and Apache serves the new list', async ({ request }) => {
  // Regression: 662a74f89 ("prevent apache reload echoing out status on api
  // call").  The reload's "Apache configuration reloaded successfully." went
  // out ahead of the JSON answer, which the page could not parse.  The reload
  // goes through scripts/common as on a device (systemd answered by a
  // stand-in that reloads the real Apache).
  apacheSystemctl();
  const r = await save(request, [{ host: ctl, description: 'fpp-tests' }]);
  const text = await r.text();
  expect(() => JSON.parse(text), text).not.toThrow();
  expect(JSON.parse(text)).toEqual([{ host: ctl, description: 'fpp-tests' }]);
  await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('controller:80:/fpp-tests');
});

test('a saved proxy is listed once', async ({ request }) => {
  // Regression: e7a76634f ("Fix a bunch of issues with proxies and dhcp
  // server").  Since bde95aa80 each saved host has rules for "<host>:$1",
  // and LoadProxyList() skipped only a host of exactly "$1": every host came
  // back three times, twice as "<host>:$1", and the next save wrote those too.
  await save(request, [{ host: ctl, description: 'fpp-tests' }]);
  expect(await (await request.get('/api/proxies')).json()).toEqual([{ host: ctl, description: 'fpp-tests', pending: false }]);
  await save(request, (await (await request.get('/api/proxies')).json()));
  expect(await (await request.get('/api/proxies')).json()).toEqual([{ host: ctl, description: 'fpp-tests', pending: false }]);
});

test('only the saved hosts and the DHCP clients are proxied', async ({ request }) => {
  // Regression: 22170d524 ("fix proxy logic to ensure only defined and dhcp
  // hosts work as proxies").  The saved file ended in a catch-all
  // "^(.*)/(.*)$ http://$1/$2 [P]", so /proxy/ reached any host at all,
  // and a DHCP client was reached only through that.  Now each saved host
  // and each offered lease gets rules of its own, and nothing else does.
  const other = '192.0.2.50';
  await save(request, [{ host: other }]);
  inPlayer('apache2ctl', 'graceful');
  // The control: the saved host's rules are live.
  await expect.poll(() => inPlayer('cat', PROXY_CONF)).toContain(`^${other}/(.*)$`);
  expect(await reached(`${ctl}/fpp-tests`), 'an unsaved host was proxied').toBe('HTTP 404');

  offerLeases([ctl]);
  await save(request, [{ host: other }]);
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('controller:80:/fpp-tests');
});

test('the DHCP leases are listed, pending until the list is saved', async ({ request }) => {
  // Regression: 1cc724483 ("Return DHCP leases in api/proxies") listed the
  // leases this player's DHCP server offered; cb15a4e1a ("add warning if new
  // dhcp client is detected but not currently in allowed proxy list") marks
  // one that the saved file does not have yet as pending.
  const pending = '172.31.254.9';
  await save(request, [{ host: ctl }]);
  offerLeases([ctl, pending]);
  const list = await (await request.get('/api/proxies')).json();
  expect(list).toEqual([
    { host: ctl, description: '', dhcp: true, pending: false },
    { host: pending, description: '', dhcp: true, pending: true },
  ]);
});

test('the DHCP server\'s subnet is proxied as fppinit writes it', async () => {
  // Regression: e7a76634f.  For an interface running FPP's DHCP server,
  // fppinit writes config/dhcp-proxy-config.conf with rules for its /24, and
  // the site config includes it, so a DHCP client is reached before anyone
  // saves it on the Proxies page.  The real fppinit setupNetwork writes it
  // here (for a made-up interface whose address is in the controller's /24),
  // and reloads Apache through systemd (the stand-in).
  apacheSystemctl();
  const net = playerAddress().ip.split('.').slice(0, 3).join('.');
  const iface = `${MEDIA}/config/interface.eth9`;
  writeFile(iface, `INTERFACE="eth9"\nPROTO="static"\nADDRESS="${net}.1"\nNETMASK="255.255.255.0"\nDHCPSERVER="1"\n`);
  try {
    expect(await reached(`${ctl}/fpp-tests`)).toBe('HTTP 404');
    inPlayer('sh', '-c', 'timeout 120 /opt/fpp/src/fppinit setupNetwork > /dev/null 2>&1 || true');
    expect(inPlayer('sh', '-c', `cat ${MEDIA}/config/dhcp-proxy-config.conf 2>/dev/null || true`)).toContain(`^${net}.`);
    await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('controller:80:/fpp-tests');
  } finally {
    inPlayer('sh', '-c', `rm -f ${iface} ${MEDIA}/config/dhcp-proxy-config.conf /etc/systemd/network/10-eth9.network; apache2ctl graceful`);
  }
});

test('a WebSocket through /proxy reaches the controller', async () => {
  // Regression: 0f6e2bca4 ("fix websocket handling in proxies").  The
  // upgrade rule matched only one-character hosts and paths, and sent them to
  // this player's own Host: an ESPixelStick's or WLED's live view through
  // /proxy never connected.
  const base = new URL(test.info().project.use.baseURL!);
  const message = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://${base.host}/proxy/${ctl}/ws`);
    const timer = setTimeout(() => resolve('timed out'), 10_000);
    ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(String(e.data)); };
    ws.onerror = () => { clearTimeout(timer); resolve('refused'); };
  });
  expect(message).toBe('controller:80:/ws');
});

test('a controller\'s X-Powered-By does not come back through the player', async () => {
  // Regression: c89ad0b5c ("add apache config to lock down returned
  // headers"), which unsets X-Powered-By and its kind on every answer; the
  // player's own PHP sends none here (expose_php), so a proxied controller's
  // is the one that shows.
  const r = await get(`/proxy/${ctl}/api/fpp-tests`);
  expect(r.body).toBe('controller:80:/api/fpp-tests');
  expect(r.headers['x-powered-by']).toBeUndefined();
});

test('proxies saved before FPP 9 are carried over and still reached', async ({ request }) => {
  // Regression: c0c144628 ("Fix proxies to ensure migration, deletion and
  // save needed alert").  FPP 9 moved the list from config/proxies (an
  // .htaccess-style file with its own catch-all rules) to
  // config/proxy-config.conf, which the site config includes; opening the
  // Proxies page now carries the old hosts over, without the catch-alls.
  writeFile(`${MEDIA}/config/proxies`, 'RewriteEngine on\nRewriteBase /proxy/\n\n' +
    'RewriteCond %{HTTP:Upgrade}     "websocket" [NC]\nRewriteCond %{HTTP:Connection}  "Upgrade" [NC]\n' +
    'RewriteRule ^(.*)/(.*)$ "ws://$1/$2" [P]\n\n' +
    `# D:fpp-tests old\nRewriteRule ^${ctl}$  ${ctl}/  [R,L]\nRewriteRule ^${ctl}/(.*)$  http://${ctl}/$1  [P,L]\n\n` +
    'RewriteRule ^(.*)/(.*)$  http://$1/$2  [P,L]\nRewriteRule ^(.*)$  $1/  [R,L]\n\n');
  expect((await request.get('/proxies.php')).status()).toBe(200);
  const conf = inPlayer('sh', '-c', `cat ${PROXY_CONF} 2>/dev/null || true`);
  expect(conf).toContain(`^${ctl}/(.*)$`);
  expect(conf).not.toContain('^(.*)');
  expect(inPlayer('sh', '-c', `ls ${MEDIA}/config/proxies ${MEDIA}/config/proxies-safetodelete 2>&1 || true`))
    .toMatch(/No such file[\s\S]*proxies-safetodelete/);
  expect(await (await request.get('/api/proxies')).json()).toEqual([{ host: ctl, description: 'fpp-tests old', pending: false }]);
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('controller:80:/fpp-tests');
});

test('deleting every proxy empties the list and Apache stops proxying them', async ({ request }) => {
  // Regression: c0c144628: DELETE /api/proxies, which the page sends when
  // its last row is removed (it used to GET the list and do nothing).
  apacheSystemctl();
  await save(request, [{ host: ctl }]);
  await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('controller:80:/fpp-tests');
  const r = await request.delete('/api/proxies');
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual([]);
  expect(await (await request.get('/api/proxies')).json()).toEqual([]);
  await expect.poll(() => reached(`${ctl}/fpp-tests`), { timeout: 10_000 }).toBe('HTTP 404');
});
