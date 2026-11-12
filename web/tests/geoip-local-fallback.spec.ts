import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The Lookup buttons' last resort (GeoIPLocalFallback in fpp.js): the player
// cannot reach the internet and neither can the browser, so the page uses
// what the browser knows without asking anyone, its time zone and its
// language's region, and has the player map those (api/geoip?nolookup=1).
// The coordinates are then only the time zone's reference city, which the
// page has to say and keep saying until they are corrected.
//
// Runs on initialSetup.php, which holds the values until Finish: the Settings
// page saves them the moment they are filled in.  geoip-lookup.spec.ts covers
// the step before this one, the browser asking the services itself.

test.use({ timezoneId: 'America/Chicago', locale: 'en-US' });

// America/Chicago's reference city in tzdata's zone.tab.
const CHICAGO = { lat: '41.85', lon: '-87.65' };

// Nobody answers: the player's own lookup fails, and so do both services the
// browser would ask.  The nolookup request is local and goes through; what it
// was asked is kept for the test.
async function isolated(page: Page) {
  const asked: URL[] = [];
  await page.route(
    (url) => url.pathname.endsWith('/api/geoip'),
    (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has('nolookup')) return route.fulfill({ status: 502, json: { error: 'GeoIP lookup failed' } });
      asked.push(url);
      return route.fallback();
    }
  );
  await page.route('https://ipapi.co/**', (route) => route.abort('internetdisconnected'));
  await page.route('https://ipwho.is/**', (route) => route.abort('internetdisconnected'));
  return asked;
}

async function openSetup(page: Page) {
  await page.goto('/initialSetup.php', { waitUntil: 'commit' });
  await page.locator("input[value='Lookup Location']").waitFor({ state: 'visible', timeout: 10_000 });
  // Start from values the lookup has to change.
  await page.evaluate(() => {
    for (const id of ['Latitude', 'Longitude']) (document.getElementById(id) as HTMLInputElement).value = '';
  });
}

// A browser too old for Intl.Locale, with a language that names no region.
const noRegion = () => {
  (Intl as any).Locale = function () {
    throw new Error('no Intl.Locale');
  };
  Object.defineProperty(Navigator.prototype, 'language', { get: () => 'en' });
};

test("with nobody to ask, the location is the browser's time zone and region, and the page says how rough that is", async ({ page }) => {
  const asked = await isolated(page);
  await openSetup(page);
  await expect(page.locator('#approxCoordsNote')).toBeHidden();
  await page.locator("input[value='Lookup Location']").click();

  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('its location was taken from this browser instead', { timeout: 30_000 });
  await expect(dialog.locator('.modal-title')).toHaveText('Location Lookup');
  await expect(dialog.locator('b')).toHaveText(/only the centre of your time zone.*sunset out by up to an hour/);
  // The browser reported a country, so nothing was left to choose.
  await expect(dialog).not.toContainText('did not report which country');

  // One local request, with the browser's two hints.
  expect(asked).toHaveLength(1);
  expect(Object.fromEntries(asked[0].searchParams)).toEqual({ nolookup: '1', country: 'US', timezone: 'America/Chicago' });

  await expect(page.locator('#Latitude')).toHaveValue(CHICAGO.lat);
  await expect(page.locator('#Longitude')).toHaveValue(CHICAGO.lon);
  await expect(page.locator('#TimeZone')).toHaveValue('America/Chicago');
  await expect(page.locator('#LegalJurisdiction')).toHaveValue('US');

  // The warning outlives the dialog, and goes once a coordinate is corrected.
  await dialog.getByRole('button', { name: /close|ok/i }).first().click();
  await expect(dialog).toBeHidden();
  const note = page.locator('#approxCoordsNote');
  await expect(note).toBeVisible();
  await expect(note).toContainText('estimated from your time zone');
  await page.locator('#Latitude').fill('30.27');
  await expect(note).toBeHidden();
});

test.describe('in a time zone zone.tab places nowhere', () => {
  // UTC is a zone, but not one with a reference city.
  test.use({ timezoneId: 'UTC' });

  test('a time zone with no place on the map fills in the region and asks for the coordinates', async ({ page }) => {
    const asked = await isolated(page);
    await openSetup(page);
    await page.locator("input[value='Lookup Location']").click();

    const dialog = page.locator('.modal.show');
    await expect(dialog).toContainText('Latitude and longitude could not be filled in', { timeout: 30_000 });
    await expect(dialog).toContainText('use Show On Map once you have');
    await expect(dialog).not.toContainText('centre of your time zone');
    expect(asked[0].searchParams.get('timezone')).toBe('UTC');
    await expect(page.locator('#Latitude')).toHaveValue('');
    await expect(page.locator('#LegalJurisdiction')).toHaveValue('US');
    await expect(page.locator('#approxCoordsNote')).toBeHidden();
  });

  test('Lookup Time Zone with no coordinates to give does not ask for them', async ({ page }) => {
    await isolated(page);
    await openSetup(page);
    const button = page.locator("input[value='Lookup Time Zone']");
    test.skip((await button.count()) === 0, 'no Lookup Time Zone button on this platform');
    await button.click();

    const dialog = page.locator('.modal.show');
    await expect(dialog).toContainText('its location was taken from this browser instead', { timeout: 30_000 });
    await expect(dialog.locator('.modal-title')).toHaveText('Time Zone Lookup');
    await expect(dialog).not.toContainText('Latitude and longitude could not be filled in');
    await expect(page.locator('#TimeZone')).toHaveValue('UTC');
  });
});

test('a browser that names no country gets the place from its time zone and is told the region is left to choose', async ({ page }) => {
  await page.addInitScript(noRegion);
  const asked = await isolated(page);
  await openSetup(page);
  const jurisdiction = await page.locator('#LegalJurisdiction').inputValue();
  await page.locator("input[value='Lookup Location']").click();

  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('did not report which country it is in, so the region settings were left for you to choose', {
    timeout: 30_000,
  });
  // ZZ stands in for the country: nolookup needs one, and ZZ maps to nothing.
  expect(Object.fromEntries(asked[0].searchParams)).toEqual({ nolookup: '1', country: 'ZZ', timezone: 'America/Chicago' });
  await expect(page.locator('#Latitude')).toHaveValue(CHICAGO.lat);
  await expect(page.locator('#LegalJurisdiction')).toHaveValue(jurisdiction);
  await expect(page.locator('#approxCoordsNote')).toBeVisible();
});

test('a browser that knows neither its time zone nor its country is an error, with nothing asked of the player', async ({ page }) => {
  await page.addInitScript(noRegion);
  await page.addInitScript(() => {
    (Intl as any).DateTimeFormat = function () {
      throw new Error('no Intl.DateTimeFormat');
    };
  });
  const asked = await isolated(page);
  await openSetup(page);
  await page.locator("input[value='Lookup Location']").click();

  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('Lookup failed, and this browser could not tell us anything about where it is either.', {
    timeout: 30_000,
  });
  expect(asked).toHaveLength(0);
  await expect(page.locator('#Latitude')).toHaveValue('');
});

test("the player failing to map the browser's hints is reported as a failed lookup", async ({ page }) => {
  await isolated(page);
  await page.route(
    (url) => url.pathname.endsWith('/api/geoip') && url.searchParams.has('nolookup'),
    (route) => route.fulfill({ status: 500, body: 'no' })
  );
  await openSetup(page);
  await page.locator("input[value='Lookup Location']").click();

  await expect(page.locator('.modal.show')).toContainText('Lookup failed and the fallback could not be applied.', { timeout: 30_000 });
  await expect(page.locator('#Latitude')).toHaveValue('');
  await expect(page.locator('#approxCoordsNote')).toBeHidden();
});

test('on the Settings page, which has no warning of its own, one is put under the coordinates', async ({ page }) => {
  await isolated(page);
  // The Settings page saves each value as it is filled in.  The player's
  // location is not this test's to change, so the saves are answered here.
  const saved: string[] = [];
  await page.route('**/api/settings/*', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    saved.push(new URL(route.request().url()).pathname.split('/').pop()!);
    return route.fulfill({ json: { status: 'OK' } });
  });
  await page.goto('/settings.php?tab=Localization');
  const lookup = page.locator("input[value='Lookup Location']");
  await expect(lookup).toBeVisible();
  await expect(page.locator('#approxCoordsNote')).toHaveCount(0);
  await lookup.click();

  const dialog = page.locator('.modal.show');
  await expect(dialog).toContainText('only the centre of your time zone', { timeout: 30_000 });
  await expect(page.locator('#Latitude')).toHaveValue(CHICAGO.lat);
  await expect.poll(() => saved).toEqual(expect.arrayContaining(['Latitude', 'Longitude']));

  const note = page.locator('#approxCoordsNote');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('estimated from your time zone');
  // Straight after the coordinates' row, not at the foot of the page.
  expect(await note.evaluate((n) => !!n.previousElementSibling?.querySelector('#Longitude'))).toBe(true);
  await dialog.getByRole('button', { name: /close|ok/i }).first().click();
  await expect(note).toBeVisible();
  await page.locator('#Longitude').fill('-97.74');
  await expect(note).toBeHidden();
});
