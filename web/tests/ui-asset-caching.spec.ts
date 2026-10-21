import { test, expect } from './fixtures';

// How the player lets browsers cache its pages and assets (the site config
// and the pages' own includes in the tree under test).

function header(r: { headersArray(): { name: string; value: string }[] }, name: string): string {
  return r.headersArray().filter((h) => h.name.toLowerCase() === name).map((h) => h.value).join(', ');
}

test('a page is never cached as immutable', async ({ request }) => {
  // Coverage for fda82dd6e, which added php to the types the site config
  // strips "immutable" from: a page that kept it could skip revalidation on a
  // reload and go on naming the old ?ref= of every asset after an upgrade.
  // (The test player's php-fpm answers never carried it, so this cannot fail
  // on the parent; it pins the outcome.)
  for (const path of ['/index.php', '/settings.php', '/filemanager.php']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(header(r, 'cache-control'), path).not.toContain('immutable');
  }
});

// The pages 935ca0295 stamped.  upgradefpp.php needs arguments to render.
const PAGES = ['backup', 'commandPresets', 'effects', 'index', 'initialSetup', 'multisync', 'playlistEditor', 'proxies',
  'scheduler', 'settings-all', 'settings-storage', 'settings', 'system-stats', 'testing', 'virtualdisplay',
  'virtualdisplaywrapper3d'];

test('every script and stylesheet a page includes carries a cache buster', async ({ request }) => {
  // Regression: 935ca0295.  Assets are cached for a year, and 52 page-local
  // <script>/<link> tags across these pages had no ?ref=, so an upgrade left
  // browsers running the old file.
  const bare: string[] = [];
  let seen = 0;
  for (const p of PAGES) {
    const r = await request.get(`/${p}.php`);
    expect(r.status(), p).toBe(200);
    // Tags only: inline scripts build markup in strings of their own.
    const html = (await r.text()).replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
    for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\1/gis)) {
      const url = m[2];
      if (!/\.(js|css)(\?|$)/.test(url) || /^(https?:)?\/\//.test(url)) continue;
      seen++;
      if (!/[?&]ref=/.test(url)) bare.push(`${p}.php: ${url}`);
    }
  }
  expect(seen).toBeGreaterThan(100);
  expect(bare).toEqual([]);
});
