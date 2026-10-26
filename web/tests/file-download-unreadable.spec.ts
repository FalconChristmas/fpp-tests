import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { denying, preloadDeny, unpreloadDeny } from './fakedeny';
import { putFile } from './settings-file';

// Regression: bc3d98868 ("Fix zero-byte download of manually copied files
// from Uploads directory").  A file copied into the Uploads folder by hand
// (scp or a USB copy as root) is root's and 0600, which the web user (fpp)
// can't open: GetFileImpl() readfile()d it and sent nothing, with a 200.  It
// is now sent through sudo cat (sudo tail for ?tail=).  The Content-Length
// it also set never reached the client (Apache's mod_proxy_fcgi drops it) and
// is gone since b3c72029b; file-download-whole.spec.ts checks the framing.
// The web user's refusal is fakedeny.so's (fakedeny.ts), as php-fpm runs as
// root here.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const NAME = 'fpp-tests-root-only.txt';
const PATH = `/home/fpp/media/upload/${NAME}`;
const BODY = Array.from({ length: 50 }, (_, i) => `line ${i} of a file only root can read`).join('\n') + '\n';

test.beforeAll(() => preloadDeny());
test.afterAll(() => {
  unpreloadDeny();
  inPlayer('rm', '-f', PATH);
});

test.beforeEach(() => {
  putFile(PATH, BODY);
  inPlayer('sh', '-c', `chown root:root ${PATH} && chmod 600 ${PATH}`);
});

test("a root-only file in Uploads downloads whole", async ({ request }) => {
  await denying({ read: [PATH] }, async () => {
    const r = await request.get(`/api/file/Uploads/${NAME}`);
    expect(r.status()).toBe(200);
    const body = await r.body();
    expect(body.length, 'the download came back empty').toBe(Buffer.byteLength(BODY));
    expect(body.toString()).toBe(BODY);
  });
});

test("the tail of a root-only file in Uploads is its last lines", async ({ request }) => {
  await denying({ read: [PATH] }, async () => {
    const r = await request.get(`/api/file/Uploads/${NAME}?tail=3`);
    expect(r.status()).toBe(200);
    expect(await r.text()).toBe(BODY.split('\n').slice(-4).join('\n'));
  });
});

test('the control: a file the web user can read downloads the same', async ({ request }) => {
  const r = await request.get(`/api/file/Uploads/${NAME}`);
  expect(await r.text()).toBe(BODY);
});
