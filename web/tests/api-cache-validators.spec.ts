import { test, expect } from './fixtures';
import http from 'http';
import { container, inPlayer } from './container';
import { MEDIA } from './settings-file';

// The file-backed API routes (/api/configfile/*, /api/settings) carry
// validators, and a client revalidating an unchanged file gets a 304 instead
// of the body. Feature: f22cb28a1 ("compress JSON, and give the file-backed
// API routes validators"), which also added the JSON types to the vhost's
// compression: before it, every handler that set its content type correctly
// was served uncompressed.

// A request on a connection of its own, with exactly these headers, and the
// raw (still compressed) reply.
function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const base = test.info().project.use.baseURL!;
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const ROUTES = ['/api/settings', '/api/configfile/commandPresets.json'];

test('the file-backed routes are compressed and answer a revalidation with a 304', async () => {
  for (const route of ROUTES) {
    const first = await get(route, { 'Accept-Encoding': 'gzip' });
    expect(first.status, route).toBe(200);
    expect(first.headers['content-encoding'], `${route} was not compressed`).toBe('gzip');
    const etag = first.headers['etag'];
    expect(etag, `${route} has no ETag`).toBeTruthy();
    // As a browser does: the tag as received (Apache adds -gzip to it).
    const again = await get(route, { 'Accept-Encoding': 'gzip', 'If-None-Match': etag! });
    expect(again.status, `${route} sent the whole body again`).toBe(304);
    // The control: a tag that does not match gets the body.
    expect((await get(route, { 'Accept-Encoding': 'gzip', 'If-None-Match': '"fpp-tests"' })).status).toBe(200);
  }
});

// Regression: 606abe7f4 ("stop 304s from the file-backed routes being cached
// for a year"). The 304 reached mod_expires with no Content-Type and took the
// vhost's one-year ExpiresDefault; a browser copies a 304's headers onto what
// it has stored, so after one unchanged refetch it served the route from its
// cache for a year without asking.
test('a 304 from a file-backed route is not cacheable for a year', async () => {
  for (const route of ROUTES) {
    const first = await get(route);
    const again = await get(route, { 'If-None-Match': first.headers['etag']! });
    expect(again.status, route).toBe(304);
    for (const [what, r] of [['200', first], ['304', again]] as const) {
      expect(r.headers['cache-control'], `${route} ${what}`).toMatch(/^no-cache\b/);
      expect(r.headers['cache-control'], `${route} ${what}`).not.toContain('max-age');
      expect(r.headers['expires'], `${route} ${what} has no Expires`).toBeTruthy();
      expect(Date.parse(r.headers['expires']!), `${route} ${what} expires in the future`).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  }
});

// Regression: a90fcd3b7 ("don't trust a file's mtime as a validator while it
// is still racy"). The tag was size-mtime-inode, and mtime is to the second:
// rewriting a file in place with as many bytes in the same second left the tag
// unchanged, so a client that read in between was answered 304 and kept the
// old file until some later write changed the size or the second.
test('a same-size rewrite in the same second is not answered 304', async () => {
  test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');
  const name = 'fpp-tests-racy.json';
  const file = `${MEDIA}/config/${name}`;
  try {
    let result = '';
    // Write A, read its tag, rewrite with B in place: all in one second, or
    // try again.
    for (let i = 0; i < 10 && !result; i++) {
      const out = inPlayer('sh', '-c', [
        `printf '{"v":"A"}' > ${file}`,
        `a=$(stat -c %Y:%i ${file})`,
        `tag=$(curl -s -D - -o /dev/null http://127.0.0.1/api/configfile/${name} | sed -n 's/^[Ee][Tt]ag: *//p' | tr -d '\\r')`,
        `printf '{"v":"B"}' > ${file}`,
        `b=$(stat -c %Y:%i ${file})`,
        `[ "$a" = "$b" ] && echo "$tag"`,
      ].join('; ')).trim();
      if (out) result = out;
    }
    expect(result, 'never got both writes into one second').toBeTruthy();
    const r = await get(`/api/configfile/${name}`, { 'If-None-Match': result });
    expect(r.status, 'answered 304 with the older file').toBe(200);
    expect(r.body.toString()).toBe('{"v":"B"}');
  } finally {
    inPlayer('rm', '-f', file);
  }
});
