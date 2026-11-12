import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// One proxy at a time: POST and DELETE /api/proxies/<host>
// (www/api/controllers/proxies.php AddProxy, DeleteProxy).  Each rewrites
// Apache's proxy rules, so the config file is read after each request: a host
// that was deleted must have no rule left, and the others must keep theirs.

test.skip(!container, "keeps the run-web.sh container's proxy config");

const CONF = `${MEDIA}/config/proxy-config.conf`;
let before: string | undefined;

test.beforeEach(() => {
  before = exists(CONF) ? readFile(CONF) : undefined;
});
test.afterEach(async ({ request }) => {
  if (before === undefined) inPlayer('rm', '-f', CONF);
  else putFile(CONF, before);
  // Apache reads the rules when it is told to: have it read the ones put back.
  inPlayer('sh', '-c', '/opt/fpp/scripts/common gracefullyReloadApacheConf >/dev/null 2>&1 || true');
  await expect.poll(async () => (await request.get('/api/proxies').catch(() => null))?.status(), { timeout: 15_000 }).toBe(200);
});

const hosts = (list: any[]) => list.filter((p) => !p.dhcp).map((p) => p.host);
const seed = (request: APIRequestContext) => request.post('/api/proxies', { data: [
  { host: '192.0.2.10', description: 'garage' },
  { host: '192.0.2.11', description: 'mega tree' },
  { host: 'fpp-tests-proxy.example', description: '' },
] });

test('deleting one proxy removes its rules and leaves the others with their descriptions', async ({ request }) => {
  expect((await seed(request)).status()).toBe(200);
  const r = await request.delete('/api/proxies/192.0.2.10');
  expect(r.status()).toBe(200);
  const left = (await r.json()).filter((p: any) => !p.dhcp);
  expect(left).toEqual([
    expect.objectContaining({ host: '192.0.2.11', description: 'mega tree' }),
    expect.objectContaining({ host: 'fpp-tests-proxy.example', description: '' }),
  ]);
  const conf = readFile(CONF);
  expect(conf, 'a rule for the deleted host is left').not.toContain('192.0.2.10');
  expect(conf).toContain('# D:mega tree\nRewriteRule ^192.0.2.11$  192.0.2.11/  [R,L]');
  expect(conf).toContain('http://fpp-tests-proxy.example/$1');
  expect(hosts(await (await request.get('/api/proxies')).json())).toEqual(['192.0.2.11', 'fpp-tests-proxy.example']);
});

test('deleting a host that is only the start of another, or is not listed, deletes nothing', async ({ request }) => {
  expect((await seed(request)).status()).toBe(200);
  for (const host of ['192.0.2.1', '192.0.2.99', 'fpp-tests-proxy']) {
    const r = await request.delete(`/api/proxies/${host}`);
    expect(r.status(), host).toBe(200);
    expect(hosts(await r.json()), host).toEqual(['192.0.2.10', '192.0.2.11', 'fpp-tests-proxy.example']);
  }
  expect(readFile(CONF)).toContain('# D:garage\nRewriteRule ^192.0.2.10$');
});

test('deleting the last proxy leaves no rule', async ({ request }) => {
  expect((await request.post('/api/proxies', { data: [{ host: '192.0.2.10', description: 'only' }] })).status()).toBe(200);
  const r = await request.delete('/api/proxies/192.0.2.10');
  expect(hosts(await r.json())).toEqual([]);
  expect(readFile(CONF)).not.toContain('192.0.2.10');
  expect(readFile(CONF)).not.toContain('# D:only');
});

test('adding a proxy that is listed already changes nothing, and a host that is not a host is refused', async ({ request }) => {
  expect((await seed(request)).status()).toBe(200);
  const conf = readFile(CONF);

  let r = await request.post('/api/proxies/192.0.2.11');
  expect(r.status()).toBe(200);
  expect(hosts(await r.json())).toEqual(['192.0.2.10', '192.0.2.11', 'fpp-tests-proxy.example']);
  expect(readFile(CONF), 'the description it had').toBe(conf);

  for (const bad of ['bad%20host', 'a%24b', 'x%0ARewriteRule']) {
    r = await request.post(`/api/proxies/${bad}`);
    expect(r.status(), bad).toBe(400);
    expect(await r.json(), bad).toEqual({ error: 'Invalid proxy host' });
  }
  expect(readFile(CONF)).toBe(conf);

  r = await request.post('/api/proxies/192.0.2.12');
  expect(hosts(await r.json())).toEqual(['192.0.2.10', '192.0.2.11', 'fpp-tests-proxy.example', '192.0.2.12']);
  expect(readFile(CONF)).toContain('RewriteRule ^192.0.2.12/(.*)$  http://192.0.2.12/$1  [P,L]');
});
