import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The location lookup's offline fallback (GeoIPLocalFallback, api/geoip?
// nolookup=1, TimeZoneCoordinates) for a browser whose time zone is one of the
// names tzdata keeps only as a link: Chromium reports ICU's IDs, which for
// India is "Asia/Calcutta" (tzdata: Asia/Kolkata), for Ukraine "Europe/Kiev"
// (Europe/Kyiv), for Vietnam "Asia/Saigon" (Asia/Ho_Chi_Minh).  zone.tab
// lists only the canonical names.  geoip-local-fallback.spec.ts has the rest.

async function isolated(page: Page) {
  await page.route((u) => u.pathname.endsWith('/api/geoip'), (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('nolookup')) return route.fulfill({ status: 502, json: { error: 'GeoIP lookup failed' } });
    return route.fallback();
  });
  await page.route('https://ipapi.co/**', (r) => r.abort('internetdisconnected'));
  await page.route('https://ipwho.is/**', (r) => r.abort('internetdisconnected'));
}

async function lookup(page: Page) {
  await isolated(page);
  await page.goto('/initialSetup.php', { waitUntil: 'commit' });
  await page.locator("input[value='Lookup Location']").waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => {
    for (const id of ['Latitude', 'Longitude']) (document.getElementById(id) as HTMLInputElement).value = '';
  });
  await page.locator("input[value='Lookup Location']").click();
  await expect(page.locator('.modal.show')).toContainText('its location was taken from this browser instead', { timeout: 30_000 });
}

test('the API places a link name where it places the zone it links to', async ({ request }) => {
  const at = async (tz: string) => (await (await request.get(`/api/geoip?nolookup=1&country=IN&timezone=${tz}`)).json()).fpp;
  expect(await at('Asia/Kolkata')).toMatchObject({ Latitude: '22.5333', Longitude: '88.3667' });
  test.fail(true, 'TimeZoneCoordinates reads only zone.tab, which has no link names (FUTURE.md)');
  for (const [alias, lat] of [['Asia/Calcutta', '22.5333'], ['Europe/Kiev', '50.4333'], ['Asia/Saigon', '10.75']]) {
    expect((await at(alias)).Latitude, alias).toBe(lat);
  }
});

test.describe('in India', () => {
  test.use({ timezoneId: 'Asia/Kolkata', locale: 'en-IN' });

  test("a browser in India is placed at its time zone's city", async ({ page }) => {
    test.fail(true, 'Chromium reports Asia/Calcutta, which zone.tab does not list (FUTURE.md)');
    await lookup(page);
    await expect(page.locator('#Latitude')).toHaveValue('22.5333');
    await expect(page.locator('#Longitude')).toHaveValue('88.3667');
  });

  test('the Settings page lookup keeps a time zone it cannot match instead of saving a non-zone', async ({ page }) => {
    // Chromium says Asia/Calcutta; this tzdata (Debian 13 without
    // tzdata-legacy) has no such file, so the Time Zone list has only
    // Asia/Kolkata.  $('#TimeZone').val() of a missing option empties the
    // select, and its change saves that.  The saves are answered here.
    test.fail(true, 'SetFromGeoIP sets a value the select does not have and fires change: TimeZone is saved as "null" (FUTURE.md)');
    await isolated(page);
    const saved: Record<string, string> = {};
    await page.route('**/api/settings/*', (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      saved[new URL(route.request().url()).pathname.split('/').pop()!] = route.request().postData() ?? '';
      return route.fulfill({ json: { status: 'OK' } });
    });
    await page.goto('/settings.php?tab=Localization');
    const before = await page.locator('#TimeZone').inputValue();
    expect(before).not.toBe('');
    await page.locator("input[value='Lookup Location']").click();
    await expect(page.locator('.modal.show')).toContainText('its location was taken from this browser instead', { timeout: 30_000 });
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Calcutta');
    await expect.poll(() => Object.keys(saved)).toContain('TimeZone');
    await page.waitForTimeout(1000);
    // Saved as the zone it links to, or not saved at all: never "null" (what
    // the emptied select sends) or "".
    expect(saved.TimeZone ?? before, 'TimeZone was saved as something that is not a zone').toMatch(/^(UTC|[A-Z][A-Za-z]+\/[A-Za-z_\/+-]+)$/);
    expect(await page.locator('#TimeZone').inputValue()).not.toBe('');
  });
});
