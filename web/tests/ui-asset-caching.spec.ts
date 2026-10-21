import { execFileSync } from 'child_process';
import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { writeFile } from './privacy-helpers';

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

// The page's own scripts and stylesheets: every local .js/.css a <script> or
// <link> tag names, as written in the page.
async function localIncludes(request: any, page: string): Promise<string[]> {
  const r = await request.get(`/${page}.php`);
  expect(r.status(), page).toBe(200);
  // Tags only: inline scripts build markup in strings of their own.
  const html = (await r.text()).replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>');
  const urls: string[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\1/gis)) {
    const url = m[2];
    if (!/\.(js|css)(\?|$)/.test(url) || /^(https?:)?\/\//.test(url)) continue;
    urls.push(url);
  }
  return urls;
}

test('every script and stylesheet a page includes carries a cache buster', async ({ request }) => {
  // Regression: 935ca0295.  Assets are cached for a year, and 52 page-local
  // <script>/<link> tags across these pages had no ?ref=, so an upgrade left
  // browsers running the old file.
  const bare: string[] = [];
  let seen = 0;
  for (const p of PAGES) {
    for (const url of await localIncludes(request, p)) {
      seen++;
      if (!/[?&]ref=/.test(url)) bare.push(`${p}.php: ${url}`);
    }
  }
  expect(seen).toBeGreaterThan(100);
  expect(bare).toEqual([]);
});

test('each cache buster is the modification time of the file it names, and moves with it', async ({ request }) => {
  // Regression: 935ca0295 stamped each include with ?ref=filemtime() of that
  // same file, so the URL changes exactly when the file does.  A tree's files
  // all share one mtime (the export's), so a buster naming the wrong file, a
  // fixed value, or an empty one (filemtime() of a path that does not
  // resolve) would look right; so every .js and .css under www/ is first
  // given an mtime of its own, and each page must then name each file's.
  // Proved red with the 17 pages reverted on master (no ref at all) and with
  // one include's ref pointed at another file.  upgradefpp.php's includes are
  // not reached: they sit in its `if (!$wrapped)` head, and $wrapped is
  // always 1, and rendering it starts an upgrade.
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');
  const WWW = '/opt/fpp/www';
  const saved = `/tmp/fpp-tests-asset-mtimes-${process.pid}.json`;
  const script = `/tmp/fpp-tests-asset-mtimes-${process.pid}.py`;
  // set: each file gets 1000000000 + its index (2001, distinct seconds);
  // restore: puts back what set saved; stat: the mtime of each path on stdin.
  writeFile(script, `
import json, os, sys
mode, www, saved = sys.argv[1:4]
if mode == 'set':
    files = sorted(os.path.join(d, f) for d, _, fs in os.walk(www) for f in fs if f.endswith(('.js', '.css')))
    json.dump({f: os.stat(f).st_mtime_ns for f in files}, open(saved, 'w'))
    for i, f in enumerate(files):
        os.utime(f, (1000000000 + i, 1000000000 + i))
elif mode == 'restore':
    for f, ns in json.load(open(saved)).items():
        os.utime(f, ns=(ns, ns))
    os.unlink(saved)
else:
    out = {}
    for p in sys.stdin.read().split():
        try:
            out[p] = int(os.stat(p).st_mtime)
        except OSError:
            out[p] = None
    print(json.dumps(out))
`);
  inPlayer('python3', script, 'set', WWW, saved);
  try {
    const found: { page: string; url: string; path: string; ref: string | null }[] = [];
    for (const p of PAGES) {
      for (const url of await localIncludes(request, p)) {
        const u = new URL(url, `http://player/${p}.php`);
        found.push({ page: p, url, path: WWW + decodeURIComponent(u.pathname), ref: u.searchParams.get('ref') });
      }
    }
    expect(found.length).toBeGreaterThan(100);
    const mtimes = JSON.parse(execFileSync('docker', ['exec', '-i', container, 'python3', script, 'stat', WWW, saved],
      { input: found.map((f) => f.path).join('\n'), encoding: 'utf8' }));
    // The control: the files really were given mtimes of their own.
    expect(new Set(found.map((f) => mtimes[f.path])).size, 'the files still share one mtime').toBeGreaterThan(20);
    const wrong = found.filter((f) => f.ref === null || mtimes[f.path] === null || f.ref !== String(mtimes[f.path]))
      .map((f) => `${f.page}.php: ${f.url} (file mtime ${mtimes[f.path]})`);
    expect(wrong).toEqual([]);
  } finally {
    inPlayer('python3', script, 'restore', WWW, saved);
    inPlayer('rm', '-f', script);
  }
});
