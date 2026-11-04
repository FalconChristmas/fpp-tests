import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// /api/system/proxies, the form-posted way to set the player's proxy list
// (proxies.php; the page and /api/proxies are covered elsewhere).  A POST
// replaces the list with the entries that hold up; each entry writes rewrite
// rules into Apache's config, so what gets in matters.

test.skip(!container, "keeps the run-web.sh container's proxy config");

const CONF = `${MEDIA}/config/proxy-config.conf`;
let before: string | undefined;

test.beforeEach(() => {
  before = exists(CONF) ? readFile(CONF) : undefined;
});
test.afterEach(() => {
  if (before === undefined) inPlayer('rm', '-f', CONF);
  else putFile(CONF, before);
});

const listed = async (request: any) => (await (await request.get('/api/system/proxies')).json())
  .filter((p: any) => !p.dhcp);

test('a proxy posted is listed, with its description', async ({ request }) => {
  const r = await request.post('/api/system/proxies', { form: { '0[host]': '192.0.2.10', '0[description]': 'garage' } });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await listed(request)).toEqual([expect.objectContaining({ host: '192.0.2.10', description: 'garage' })]);
  expect(readFile(CONF)).toContain('http://192.0.2.10/$1');
});

test('an entry whose host is not a host is dropped, and a description cannot break a config line', async ({ request }) => {
  // Regression: d3109b082, on this write path: a line break in a description
  // ended its "# D:" comment line in Apache's config.
  const r = await request.post('/api/system/proxies', { form: {
    '0[host]': 'bad host\nRewriteRule evil', '0[description]': 'dropped',
    '1[host]': 'good.example', '1[description]': '<b>tag</b>\nRewriteRule evil',
  } });
  expect(r.ok(), await r.text()).toBe(true);
  expect(await r.json()).toEqual([{ host: 'good.example', description: 'tag RewriteRule evil' }]);
  const conf = readFile(CONF);
  expect(conf).not.toContain('bad host');
  expect(conf).not.toContain('\nRewriteRule evil');
});

test('a post with no valid proxy is refused and leaves the list alone', async ({ request }) => {
  putFile(CONF, '# D:kept\nRewriteRule ^192.0.2.20/(.*)$  http://192.0.2.20/$1  [P,L]\n');
  const r = await request.post('/api/system/proxies', { form: { '0[host]': 'not a host' } });
  expect(r.status()).toBe(400);
  expect(await listed(request)).toEqual([expect.objectContaining({ host: '192.0.2.20', description: 'kept' })]);
});
