import http from 'http';
import type { AddressInfo } from 'net';
import { test, expect } from '@playwright/test';

// A dialog opened before the page has finished arriving. The template every
// dialog is cloned from (#modalDialogBase) comes in with the footer, at the
// end of the page, but a slow page shows its buttons long before that. On a
// player that served initialSetup.php in about 3 s, a Lookup Location that
// answered in that window threw inside bootstrap.Modal and the result dialog
// never appeared. Fixed in fpp 6dd0f6f88 ("fix(js): open a dialog asked for
// before the page has loaded once it has").
//
// To make the window certain rather than a matter of server speed, the page is
// fetched through a proxy that holds back everything from the template on
// until the test lets it go.

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

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('A dialog asked for while the page is still loading opens once it has', async ({ page, baseURL }) => {
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
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const mapped = page.waitForResponse((r) => r.url().includes('/api/geoip?nolookup=1'));

    await page.goto(`${proxy.origin}/initialSetup.php`, { waitUntil: 'commit' });
    await proxy.holding;
    await page.locator("input[value='Lookup Location']").click();
    await mapped;
    expect(await page.evaluate(() => document.readyState)).toBe('loading');

    proxy.release();
    await expect(page.getByText('looked up from this browser instead')).toBeVisible();
    await expect(page.locator('#Latitude')).toHaveValue('46.8772');
    expect(errors).toEqual([]);
  } finally {
    proxy.release();
    proxy.close();
  }
});
