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
