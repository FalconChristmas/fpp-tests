import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The response headers, types and cache lifetimes etc/apache2.site gives the
// player's pages and files.  Each check is on a request the real Apache of the
// tree under test answers, which is the receiving end of the site config;
// the browser acting on them (sniffing, caching) is not driven.

function header(r: { headersArray(): { name: string; value: string }[] }, name: string): string {
  return r.headersArray().filter((h) => h.name.toLowerCase() === name).map((h) => h.value).join(', ');
}

// A page, a script, a stylesheet and an image, each served by a different
// handler or type.
const FILES = ['/index.php', '/js/fpp.js', '/css/fpp.css', '/images/1x1.png', '/favicon.ico'];

test('every page and file says nosniff', async ({ request }) => {
  // Regression: 2e79f4c86 ("add nosniff to x-content-type-options in apache
  // conf").  Nothing said it before, so a browser could sniff an uploaded or
  // proxied file into a type that runs script.  The static files are the
  // check: only Apache can say it for them.
  for (const path of FILES) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(header(r, 'x-content-type-options'), path).toBe('nosniff');
  }
});

test('the Server header names Apache and nothing more', async ({ request }) => {
  // Regression: c89ad0b5c ("add apache config to lock down returned
  // headers"), which added ServerTokens Prod: Debian's default (OS) told any
  // client the exact Apache version and the distribution.
  for (const path of ['/index.php', '/js/fpp.js', '/no-such-file']) {
    const r = await request.get(path);
    expect(header(r, 'server'), path).toBe('Apache');
  }
});

test('a page asks for the browser\'s XSS filter; scripts, styles and images do not', async ({ request }) => {
  // Regression: b3ed55de8 ("Apache config hardening") set X-XSS-Protection
  // on every answer and meant to take it off the static types again; that
  // removal only worked once f99c8bf34 ("improve apache headers and mime
  // handling") made it "Header always unset", as the header is set with
  // "always".
  const page = await request.get('/index.php');
  expect(header(page, 'x-xss-protection')).toBe('1; mode=block');
  for (const path of ['/js/fpp.js', '/css/fpp.css', '/images/1x1.png']) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(header(r, 'x-xss-protection'), path).toBe('');
  }
});

test('the favicon is sent as image/x-icon', async ({ request }) => {
  // Regression: 33e3d6297 ("add ico files to apache mime definitions"):
  // Debian's mime.types gave .ico image/vnd.microsoft.icon.
  const r = await request.get('/favicon.ico');
  expect(r.status()).toBe(200);
  expect(header(r, 'content-type')).toBe('image/x-icon');
});

test('scripts and stylesheets are cached for a year and say their charset', async ({ request }) => {
  // Regression: 8e612b365 ("Apache configs for mime and cache control"):
  // ExpiresDefault of a year for what a page loads (the pages' ?ref= cache
  // busters change the URL when a file changes), and utf-8 on the text types.
  // Before it nothing set a lifetime, and a browser revalidated or
  // heuristically cached every asset.
  for (const [path, type] of [['/js/fpp.js', 'text/javascript'], ['/css/fpp.css', 'text/css']]) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
    expect(header(r, 'cache-control'), path).toMatch(/(^|[ ,])max-age=31536000\b/);
    expect(header(r, 'content-type'), path).toBe(`${type}; charset=utf-8`);
  }
  // Pages are never kept.
  expect(header(await request.get('/index.php'), 'cache-control')).toMatch(/(^|[ ,])max-age=0\b/);
});

test('a downloaded log is not cached', async ({ request }) => {
  // Regression: 6c22eff4d ("Fix log caching #2262").  /api/file sends a log
  // as application/binary, which fell to ExpiresDefault's year, so the File
  // Manager's View and Download showed the log as it was the first time.
  test.skip(!container, 'writes a log inside the run-web.sh container');
  const log = '/home/fpp/media/logs/fpp-tests-cache.log';
  inPlayer('sh', '-c', `echo fpp-tests > ${log}`);
  try {
    const r = await request.get('/api/file/Logs/fpp-tests-cache.log');
    expect(r.status()).toBe(200);
    expect(header(r, 'content-type')).toBe('application/binary');
    expect(header(r, 'cache-control')).toMatch(/(^|[ ,])max-age=0\b/);
  } finally {
    inPlayer('rm', '-f', log);
  }
});

test('Apache starts when the CSP file has not been generated yet', async () => {
  // Regression: 52c9049f0 ("change csp include to be optional incase it
  // hasn't been generated").  etc/apache2.csp is written by
  // ManageApacheContentPolicy.sh, not shipped; a plain Include of it stopped
  // Apache from starting at all until it existed.  The tree's own site config
  // is checked by the real apache2 with only the CSP path pointed somewhere
  // empty: the tree's etc/ is shared with other runs, so its CSP is not moved.
  test.skip(!container, 'runs apache2 -t inside the run-web.sh container');
  const dir = `/tmp/fpp-tests-csp-optional-${process.pid}`;
  const out = inPlayer('bash', '-c', `set -e; mkdir -p ${dir}
    sed "s#/opt/fpp/etc/apache2.csp#${dir}/not-generated.csp#" /opt/fpp/etc/apache2.site > ${dir}/site.conf
    grep -q "${dir}/not-generated.csp" ${dir}/site.conf
    sed "s#^IncludeOptional sites-enabled/.*#Include ${dir}/site.conf#" /etc/apache2/apache2.conf > ${dir}/apache2.conf
    . /etc/apache2/envvars
    apache2 -t -d /etc/apache2 -f ${dir}/apache2.conf 2>&1 && echo CONFIG-OK || true
    rm -rf ${dir}`);
  expect(out).toContain('CONFIG-OK');
});
