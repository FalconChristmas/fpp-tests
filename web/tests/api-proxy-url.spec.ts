import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// GET /api/proxy/<ip>/<path> fetches http://<ip>/<path> from the player and
// hands the body back as text: how one page reads another FPP's API through
// this one (www/api/controllers/proxies.php GetProxiedURL).  The player
// itself, at 127.0.0.1, stands in for the other host.

test.skip(!container, 'seeds a file inside the run-web.sh container');

const FILE = 'fpp-tests-proxy-url.txt';
const BODY = 'fpp-tests proxied body <b>&</b>\n';
const clean = () => inPlayer('rm', '-f', `${MEDIA}/logs/${FILE}`);
test.beforeEach(() => { clean(); putFile(`${MEDIA}/logs/${FILE}`, BODY); });
test.afterEach(clean);

test('the other host\'s answer comes back as it was sent, as plain text', async ({ request }) => {
  const r = await request.get(`/api/proxy/127.0.0.1/api/file/Logs/${FILE}`);
  expect(r.status(), await r.text()).toBe(200);
  expect(await r.text()).toBe(BODY);
  expect(r.headers()['content-type']).toContain('text/plain');

  const v = await request.get('/api/proxy/127.0.0.1/api/fppd/version');
  expect(JSON.parse(await v.text())).toEqual(await (await request.get('/api/fppd/version')).json());
});

test('an address that is not an IPv4 address is refused before anything is fetched', async ({ request }) => {
  for (const ip of ['localhost', 'example.com', '127.0.0.1:8080', '%3A%3A1', '127.1', '300.1.1.1', '127.0.0.1%40example.com', 'user%40127.0.0.1']) {
    const r = await request.get(`/api/proxy/${ip}/api/fppd/version`);
    expect(r.status(), ip).toBe(400);
    expect(await r.json(), ip).toEqual({ error: 'Invalid IP address' });
  }
});

test('a path with ".." or anything but letters, digits, - _ . / is refused', async ({ request }) => {
  for (const path of ['api/a..b', 'api/x%3Fy%3D1', 'api/a%20b', 'api/a%40b', 'api/a%23b', 'api/a%3Ab']) {
    const r = await request.get(`/api/proxy/127.0.0.1/${path}`);
    expect(r.status(), path).toBe(400);
    expect(await r.json(), path).toEqual({ error: 'Invalid URL part' });
  }
});

test('a fetch that fails is a 502, not an empty success', async ({ request }) => {
  // A page the other host does not have.
  const r = await request.get(`/api/proxy/127.0.0.1/api/file/Logs/${FILE}-gone`);
  expect(r.status()).toBe(502);
  expect(await r.json()).toEqual({ error: 'Failed to fetch proxied URL' });
});

test('a query string is not passed on, and does not change what is fetched', async ({ request }) => {
  const r = await request.get(`/api/proxy/127.0.0.1/api/file/Logs/${FILE}?play=1&x=..`);
  expect(r.status()).toBe(200);
  expect(await r.text()).toBe(BODY);
});
