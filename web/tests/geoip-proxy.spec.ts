import { test, expect } from './fixtures';
import { container } from './container';
import { FakeHttps } from './fake-https';

// Regression: b2a0b6d68 ("proxy ipapi.co GeoIP lookup through /api/geoip to
// fix CORS-blocked Timezone/GeoLocation buttons").  The Settings page's
// Lookup buttons asked ipapi.co from the browser, which the page's CSP
// doesn't allow, so they did nothing.  The player now asks, at /api/geoip.
// ipapi.co and ipwho.is are a stand-in HTTPS server inside the player
// (fake-https.ts); geoip-lookup.spec.ts covers the browser's own fallback.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const ANSWER = {
  ip: '192.0.2.7', city: 'Minot', region: 'North Dakota', country_code: 'US', in_eu: false,
  timezone: 'America/Chicago', latitude: 48.2325, longitude: -101.2963,
};

let upstream: FakeHttps;
test.beforeEach(() => {
  upstream = new FakeHttps(['ipapi.co', 'ipwho.is'], { 'ipapi.co /json/': { json: ANSWER } });
  upstream.start();
});
test.afterEach(() => upstream.stop());

test('GET /api/geoip answers with the lookup the player made', async ({ request }) => {
  const r = await request.get('/api/geoip');
  expect(r.status(), await r.text()).toBe(200);
  const body = await r.json();
  expect(body.timezone).toBe('America/Chicago');
  expect(body.latitude).toBe(48.2325);
  // The receiving end: the service was asked, by the player.
  expect(upstream.requests().map((q) => `${q.host} ${q.path}`)).toContain('ipapi.co /json/');
});

test("the Settings page's location Lookup asks the player, not ipapi.co", async ({ page, baseURL }) => {
  // The page end, on today's page: it fails on the fix's parent, but the
  // fix's own page didn't fill the fields from the reply here either, so the
  // API test above is the one that guards b2a0b6d68 itself.
  // Nothing found is to be saved over this player's location.
  const saves: string[] = [];
  await page.route((u) => u.pathname.includes('/api/settings/'), (route) => {
    if (route.request().method() === 'GET') return route.continue();
    saves.push(`${new URL(route.request().url()).pathname.split('/').pop()}=${route.request().postData()}`);
    return route.fulfill({ json: { status: 'OK' } });
  });
  const offsite: string[] = [];
  page.on('request', (q) => {
    if (new URL(q.url()).origin !== new URL(baseURL!).origin) offsite.push(q.url());
  });
  await page.goto('/settings.php');
  await page.waitForFunction(() => typeof (window as any).GetGeoLocation === 'function');
  // Its tab loads on its own, and an answer that comes first fills in nothing.
  await page.locator('#Latitude').waitFor({ state: 'attached' });
  const asked = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/geoip'));
  await page.evaluate(() => (window as any).GetGeoLocation());
  expect((await asked).status()).toBe(200);
  // The page takes the player's answer: into the fields, or (as the fix's
  // own page did, with .change()) straight into a save of each.
  const took = async (key: string, v: string) =>
    (await page.locator(`#${key}`).inputValue()) === v || saves.includes(`${key}=${v}`);
  await expect.poll(() => took('Latitude', '48.2325'), { message: JSON.stringify(saves) }).toBe(true);
  await expect.poll(() => took('Longitude', '-101.2963')).toBe(true);
  expect(offsite, 'the browser asked a geolocation service itself').toEqual([]);
});

// f99f0566a's server half: ipapi.co's free tier is rate limited per public
// address, and its refusal is still JSON, so the player goes on to ipwho.is
// and renames that service's fields to ipapi.co's.
const IPWHOIS = {
  ip: '192.0.2.9', success: true, city: 'Fargo', region: 'North Dakota', region_code: 'ND',
  country: 'United States', country_code: 'US', postal: '58102', latitude: 46.8772, longitude: -96.7898,
  is_eu: false, timezone: { id: 'America/Chicago', utc: '-06:00' }, connection: { isp: 'Example' },
};

test('a refusal from ipapi.co sends the player on to ipwho.is, whose answer comes back in ipapi.co\'s field names', async ({ request }) => {
  for (const refusal of [
    { status: 429, json: { error: true, reason: 'RateLimited' } },
    // A refusal can come as a 200 too, and so can an answer with no country.
    { json: { error: true, reason: 'Reserved IP Address' } },
    { json: { ip: '192.0.2.7', city: 'Nowhere' } },
    { body: '<html>blocked</html>' },
  ]) {
    upstream.routes({ 'ipapi.co /json/': refusal, 'ipwho.is /': { json: IPWHOIS } });
    upstream.clearLog();
    const r = await request.get('/api/geoip');
    expect(r.status(), `${JSON.stringify(refusal)}: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({
      ip: '192.0.2.9', city: 'Fargo', region: 'North Dakota', region_code: 'ND', postal: '58102',
      country: 'US', country_code: 'US', country_name: 'United States',
      latitude: 46.8772, longitude: -96.7898, in_eu: false, timezone: 'America/Chicago',
    });
    // Only the fields the page knows: nothing else of ipwho.is's passes through.
    expect(body.connection).toBeUndefined();
    expect(body.success).toBeUndefined();
    // Real coordinates, so none made up from the time zone.
    expect(body.fppCoordsFromTimeZone).toBeUndefined();
    expect(body.fpp).toMatchObject({ LegalJurisdiction: 'US', Locale: 'USA' });
    expect(body.fpp.Latitude).toBeUndefined();
    expect(upstream.requests().map((q) => `${q.host} ${q.path}`)).toEqual(['ipapi.co /json/', 'ipwho.is /']);
  }
});

test('an ipwho.is answer with only a country is still an answer, and the time zone hint places it', async ({ request }) => {
  upstream.routes({ 'ipapi.co /json/': { status: 429, json: { error: true } }, 'ipwho.is /': { json: { success: true, country_code: 'US' } } });
  const r = await request.get('/api/geoip', { params: { timezone: 'America/Chicago' } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body).toMatchObject({ country: 'US', country_code: 'US', timezone: 'America/Chicago', fppCoordsFromTimeZone: true });
  expect(body.fpp).toMatchObject({ Latitude: '41.85', Longitude: '-87.65' });
  expect(body.latitude).toBeUndefined();
});

test('with neither service giving an answer the lookup is a 502, unless a country was supplied', async ({ request }) => {
  for (const second of [
    { json: { success: false, message: 'You have exceeded the limit' } },
    { json: { success: true } },
    { status: 500, body: 'oops' },
  ]) {
    upstream.routes({ 'ipapi.co /json/': { status: 429, json: { error: true } }, 'ipwho.is /': second });
    const r = await request.get('/api/geoip');
    expect(r.status(), JSON.stringify(second)).toBe(502);
    expect(await r.json()).toEqual({ error: 'GeoIP lookup failed' });
  }
  // A supplied country is mapped whatever the services say.
  const r = await request.get('/api/geoip', { params: { country: 'de' } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body).toMatchObject({ country_code: 'DE', country: 'DE', fppCountryOverride: true });
  expect(body.fpp.WifiRegulatoryDomain).toBe('DE');
});

test('a supplied country replaces the one looked up, and nolookup asks nobody', async ({ request }) => {
  // The lookup's own answer, with the country swapped and the provider's EU
  // flag dropped: it described the other country.
  upstream.routes({ 'ipapi.co /json/': { json: { ...ANSWER, in_eu: true } } });
  let body = await (await request.get('/api/geoip', { params: { country: 'CA' } })).json();
  expect(body).toMatchObject({ country_code: 'CA', city: 'Minot', latitude: 48.2325, fppCountryOverride: true });
  expect(body.in_eu).toBeUndefined();
  expect(upstream.requests()).toHaveLength(1);

  upstream.clearLog();
  body = await (await request.get('/api/geoip', { params: { country: 'CA', nolookup: '1' } })).json();
  expect(body).toMatchObject({ country_code: 'CA', fppCountryOverride: true });
  expect(body.city).toBeUndefined();
  expect(upstream.requests()).toEqual([]);
  // nolookup means nothing without a country: the lookup is made.
  expect((await request.get('/api/geoip', { params: { nolookup: '1' } })).status()).toBe(200);
  expect(upstream.requests()).toHaveLength(1);
});

test('a country or time zone that is not one is refused before anything is looked up', async ({ request }) => {
  for (const [params, error] of [
    [{ country: 'USA' }, 'country must be a two-letter code'],
    [{ country: 'U1' }, 'country must be a two-letter code'],
    [{ country: 'US', timezone: '../etc/passwd' }, 'invalid timezone'],
    [{ timezone: 'America/New York' }, 'invalid timezone'],
    [{ timezone: 'A'.repeat(65) }, 'invalid timezone'],
  ] as const) {
    const r = await request.get('/api/geoip', { params });
    expect(r.status(), JSON.stringify(params)).toBe(400);
    expect(await r.json()).toEqual({ error });
  }
  expect(upstream.requests()).toEqual([]);
});
