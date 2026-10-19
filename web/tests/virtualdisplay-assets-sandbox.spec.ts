import { test, expect } from './fixtures';

// virtualdisplay_assets is linked into the web root, Apache serves it
// directly, and the file API writes to it with no extension filter.  An .html
// or .svg put there and opened from /virtualdisplay_assets/ came back as a
// page of the player's own origin, and the site CSP allows inline script, so
// its script ran with full use of the player's API.  Fixed in fpp 65432a4ff
// ("fix(apache): pages uploaded to virtualdisplay_assets open sandboxed"): the
// directory is served with CSP "sandbox".

const PAGES: { name: string; body: string }[] = [
  {
    name: 'fpp-tests-sandbox.html',
    body: '<!doctype html><html><head><title>untouched</title></head>' +
      '<body><p id="marker">uploaded page</p>' +
      '<script>document.title = "script ran"; window.__ran = 1;</script></body></html>',
  },
  {
    name: 'fpp-tests-sandbox.svg',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<text id="marker" x="10" y="50">uploaded svg</text>' +
      '<script>window.__ran = 1;</script></svg>',
  },
];

for (const { name, body } of PAGES) {
  test(`an uploaded ${name.split('.').pop()} in virtualdisplay_assets runs no script`, async ({ page, request }) => {
    const up = await request.post(`/api/file/virtualdisplay_assets/${name}`, { data: body });
    expect(up.ok(), await up.text()).toBe(true);
    try {
      const resp = await page.goto(`/virtualdisplay_assets/${name}`);
      expect(resp?.status()).toBe(200);
      // The document itself was served and parsed, so a script that did not
      // run was held back rather than never delivered.
      await expect(page.locator('#marker')).toBeVisible();
      expect(await page.evaluate(() => (window as any).__ran)).toBeUndefined();
    } finally {
      await request.delete(`/api/file/virtualdisplay_assets/${name}`);
    }
  });
}

// Every type is served with the sandbox, including the ones the server-wide
// mod_headers rules strip Content-Security-Policy from. A <FilesMatch> merges
// after a <Directory>, so before fpp d53e40b9f ("fix(apache): every file in
// virtualdisplay_assets is served sandboxed") an .rss, .atom or .rdf -- which
// browsers render as XML, script included -- came back without it.
test('every type served from virtualdisplay_assets carries the sandbox', async ({ request }) => {
  const exts = ['rss', 'atom', 'rdf', 'txt', 'json', 'md', 'js', 'css', 'png', 'html', 'svg', 'xml', 'obj', 'mtl'];
  const missing: string[] = [];
  for (const ext of exts) {
    const name = `fpp-tests-sandbox-type.${ext}`;
    const up = await request.post(`/api/file/virtualdisplay_assets/${name}`, { data: 'fpp-tests' });
    expect(up.ok(), `upload ${name}: ${await up.text()}`).toBe(true);
    try {
      const r = await request.get(`/virtualdisplay_assets/${name}`);
      expect(r.status(), name).toBe(200);
      const csp = r.headersArray().filter((h) => h.name.toLowerCase() === 'content-security-policy').map((h) => h.value);
      if (!csp.some((v) => /\bsandbox\b/.test(v))) missing.push(`${ext} (${csp.join(' | ') || 'no CSP'})`);
    } finally {
      await request.delete(`/api/file/virtualdisplay_assets/${name}`);
    }
  }
  expect(missing, 'types served without the sandbox').toEqual([]);
});
