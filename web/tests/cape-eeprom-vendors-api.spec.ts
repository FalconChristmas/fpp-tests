import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { FakeHttps } from './fake-https';

// GET /api/cape/eeprom/vendors: the player fetches the fpp-data vendor index
// and every vendor's own cape list itself (so a page needs neither CORS nor
// the CSP to be open to the vendors), and caches the index in
// media/tmp/eepromVendors.json, from which the CSP generator allows each
// vendor's origin for the browser-side fallback.  The hosts are stood in for
// inside the player (fake-https.ts).

test.skip(!container, 'stands in for GitHub and the vendors inside the run-web.sh container');
test.describe.configure({ mode: 'serial' });

const INDEX_HOST = 'raw.githubusercontent.com';
const INDEX_PATH = '/FalconChristmas/fpp-data/master/eepromVendors.json';
const WWW = 'www.fpp-tests-vendor.invalid';
const DEEP = 'lists.fpp-tests-other.invalid';
const DOWN = 'gone.fpp-tests-third.invalid';
const CACHE = '/home/fpp/media/tmp/eepromVendors.json';
const CSP_FILE = '/opt/fpp/etc/apache2.csp';
const CSP_SAVED = '/tmp/fpp-tests-vendors-apache2.csp';

let fake: FakeHttps;

test.beforeEach(() => {
  fake = new FakeHttps([INDEX_HOST, WWW, DEEP, DOWN]);
  fake.routes({
    [`${INDEX_HOST} ${INDEX_PATH}`]: { json: { vendors: [
      { name: 'First', url: `https://${WWW}/eeproms.json` },
      { name: 'Second', url: `https://${DEEP}/eeproms.json` },
      { name: 'Third', url: `https://${DOWN}/eeproms.json` },
    ] } },
    [`${WWW} /eeproms.json`]: { json: { name: 'First Vendor', capes: { 'cape one': { versions: {} } } } },
    [`${DEEP} /eeproms.json`]: { json: { name: 'Second Vendor', capes: { 'cape two': { versions: {} } } } },
    // The third vendor answers, but not with a cape list.
    [`${DOWN} /eeproms.json`]: { status: 503, body: 'down' },
  });
  fake.start();
  inPlayer('rm', '-f', CACHE);
  inPlayer('cp', '-a', CSP_FILE, CSP_SAVED);
});

// Every call that changes the cached index has the player regenerate the
// policy in the background, so put the generated file back once that is done
// and Apache on it.
test.afterEach(() => {
  fake.stop();
  inPlayer('sh', '-c', `for i in $(seq 100); do pgrep -f '[M]anageApacheContentPolicy' > /dev/null || break; sleep 0.2; done
    rm -f ${CACHE}; cp -a ${CSP_SAVED} ${CSP_FILE}; rm -f ${CSP_SAVED}; apache2ctl graceful`);
});

test('the player returns the index and each vendor\'s list, with the lists it could not get as errors', async ({ request }) => {
  // Feature: a57937411.  The page fetched the index and every vendor list from
  // the browser; the player now does it and the page asks the player first.
  const r = await request.get('/api/cape/eeprom/vendors');
  expect(r.ok(), `GET: ${r.status()} ${await r.text()}`).toBe(true);
  const body = await r.json();
  expect(body.index.vendors.map((v: any) => v.name)).toEqual(['First', 'Second', 'Third']);
  expect(body.vendors.map((v: any) => [v.name, Object.keys(v.capes), v.listURL]).sort()).toEqual([
    ['First Vendor', ['cape one'], `https://${WWW}/eeproms.json`],
    ['Second Vendor', ['cape two'], `https://${DEEP}/eeproms.json`],
  ]);
  expect(body.errors, 'the vendor that did not answer is named').toHaveLength(1);
  expect(body.errors[0]).toContain(`https://${DOWN}/eeproms.json`);
  // The receiving end: the vendors were asked by the player, once each.
  const asked = fake.requests().map((q) => q.host).sort();
  expect(asked).toEqual([DEEP, DOWN, INDEX_HOST, WWW].sort());
  // And what it cached is the index as it came.
  expect(JSON.parse(inPlayer('cat', CACHE)).vendors).toHaveLength(3);
});

test('with no index to be had the player says so and the page is left to the browser', async ({ request }) => {
  fake.routes({});
  const body = await (await request.get('/api/cape/eeprom/vendors')).json();
  expect(body.index).toBeNull();
  expect(body.vendors).toEqual([]);
  expect(body.errors[0]).toContain(`Could not fetch the vendor index from https://${INDEX_HOST}${INDEX_PATH}`);
});

test('the vendors\' origins are allowed to connect in the policy Apache serves, bare and www. forms of a two-label host only', async ({ request }) => {
  // Feature: a57937411.  The CSP generator reads the cached index; a vendor
  // whose list is at the www. form but whose site redirects to the bare
  // domain (or the other way round) needs both forms allowed.
  const served = async () => (await request.get('/index.php')).headers()['content-security-policy'] ?? '';
  const before = await served();
  expect(before).toContain('connect-src');
  expect(before).not.toContain('fpp-tests-vendor.invalid');
  const r = await request.get('/api/cape/eeprom/vendors');
  expect(r.ok()).toBe(true);
  // The player regenerates the policy in the background on a changed index.
  await expect.poll(() => inPlayer('cat', CSP_FILE), { message: 'the generated policy names the vendors', timeout: 30_000 })
    .toContain(`https://${WWW}`);
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(async () => (await served()).includes('https://fpp-tests-vendor.invalid'), { timeout: 15_000 }).toBe(true);
  const connect = (await served()).split(';').map((p) => p.trim().split(/\s+/)).find((p) => p[0] === 'connect-src') ?? [];
  expect(connect).toEqual(expect.arrayContaining([`https://${WWW}`, 'https://fpp-tests-vendor.invalid', `https://${DEEP}`]));
  expect(connect, 'a deeper host has no www. twin').not.toContain(`https://www.${DEEP}`);
});
