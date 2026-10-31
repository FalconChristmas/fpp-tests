import { test, expect } from './fixtures';

// The status page links a web app manifest, so a phone can add FPP to its
// home screen as an app with FPP's icons.

test('the status page links a web app manifest whose icons are served at their stated sizes', async ({ page, request }) => {
  // Regression: e97e424ea.  There was no manifest: a phone's "Add to Home
  // Screen" made a plain bookmark with a screenshot for its icon.
  const blocked: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy|Manifest/i.test(m.text())) blocked.push(m.text()); });
  await page.goto('/index.php');
  const href = await page.locator('head link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const url = new URL(href!, page.url());
  const r = await request.get(url.href);
  expect(r.status()).toBe(200);
  const manifest = await r.json();
  expect(manifest).toMatchObject({ name: 'Falcon Player', short_name: 'FPP', display: 'standalone' });
  // Where the app opens, and every icon, are served.
  const start = await request.get(new URL(manifest.start_url, url).href);
  expect(start.status()).toBe(200);
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const src = new URL(icon.src, url).href;
    const img = await request.get(src);
    expect(img.status(), src).toBe(200);
    expect(img.headers()['content-type'], src).toBe(icon.type);
    // A PNG's width and height are bytes 16-23 of its IHDR.
    const png = await img.body();
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, src).toBe(icon.sizes);
  }
  // Nothing on the page refused the manifest.
  await page.waitForTimeout(500);
  expect(blocked).toEqual([]);
});
