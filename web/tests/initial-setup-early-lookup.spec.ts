import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';
import { container } from './container';
import { settingInFile, snapshotSettings } from './settings-file';

// Nothing the setup wizard shows is saved before Finish.  The controls' own
// onChange handlers save at once, and the page swaps them for ones that only
// record the change once it has loaded.  Regression: 87dca876a ("hold a
// change made while the setup page is still loading until Finish").  A
// Location lookup answered before then ran the saving handlers, and the
// looked-up TimeZone, Locale and position were written to the settings file
// there and then.
//
// The page is fetched through a proxy that holds back its end (from the
// dialog template on) until the test lets it go, as page-still-loading does,
// so the lookup is certain to land while the page is still loading.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const TEMPLATE = '<div class="modal fade" id="modalDialogBase"';

async function startHoldingProxy(target: string, pagePath: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, target);
    const headers = { ...req.headers, host: url.host, 'accept-encoding': 'identity' };
    const upstream = http.request(url, { method: req.method, headers }, (up) => {
      if (url.pathname !== pagePath) {
        res.writeHead(up.statusCode!, up.headers);
        up.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const at = body.indexOf(TEMPLATE);
        const out = { ...up.headers };
        delete out['content-length'];
        res.writeHead(up.statusCode!, out);
        res.write(at < 0 ? body : body.slice(0, at));
        held();
        await released;
        res.end(at < 0 ? '' : body.slice(at));
      });
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, holding, release, close: () => server.close() };
}

test.use({ timezoneId: 'America/Chicago', locale: 'en-US' });

test.use({ timezoneId: 'America/Chicago', locale: 'en-US' });

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  restoreSettings();
});

test('a Location lookup answered while the setup page loads saves nothing', async ({ page, baseURL }) => {
  const KEYS = ['TimeZone', 'Locale', 'Latitude', 'Longitude'];
  const before = Object.fromEntries(KEYS.map((k) => [k, settingInFile(k)]));
  // The control: the lookup's answers differ from what the file holds.
  expect(before.TimeZone).not.toBe('America/Chicago');
  expect(before.Latitude).not.toBe('46.8772');

  const proxy = await startHoldingProxy(baseURL!, '/initialSetup.php');
  try {
    // The player cannot reach the internet, so the browser looks the location
    // up itself, and that answers at once.
    await page.route(
      (url) => url.pathname.endsWith('/api/geoip') && !url.searchParams.has('nolookup'),
      (route) => route.fulfill({ status: 502, json: { error: 'GeoIP lookup failed' } })
    );
    await page.route('https://ipapi.co/**', (route) =>
      route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: { country_code: 'US', latitude: 46.8772, longitude: -96.7898, timezone: 'America/Chicago' },
      })
    );
    const mapped = page.waitForResponse((r) => r.url().includes('/api/geoip?nolookup=1'));
    await page.goto(`${proxy.origin}/initialSetup.php`, { waitUntil: 'commit' });
    await proxy.holding;
    await page.locator("input[value='Lookup Location']").click();
    await mapped;
    expect(await page.evaluate(() => document.readyState)).toBe('loading');
    await expect(page.locator('#Latitude')).toHaveValue('46.8772');
    // Any save the lookup started has had time to land.
    await page.waitForTimeout(2000);
    proxy.release();
    await expect(page.getByText('looked up from this browser instead')).toBeVisible();
    await page.waitForTimeout(1000);

    const after = Object.fromEntries(KEYS.map((k) => [k, settingInFile(k)]));
    expect(after, 'the lookup was saved before Finish').toEqual(before);
    // And the wizard still holds the answers for Finish.
    expect(await page.evaluate(() => (window as any).pendingSettings.TimeZone)).toBe('America/Chicago');
  } finally {
    proxy.release();
    proxy.close();
  }
});
