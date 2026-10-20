import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// jqupload.php, the upload page and MultiSync's file-push transport, stored
// any file it was sent, including types the web server executes or obeys
// (.htaccess, .phtml, .php7) that nothing in FPP uses.  Fixed in fpp
// 58a94cb34 ("fix(jqupload): Block server-executable upload types").

const UPLOADS = '/home/fpp/media/upload';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function upload(request: APIRequestContext, name: string) {
  const r = await request.post('/jqupload.php', {
    multipart: { myfile: { name, mimeType: 'application/octet-stream', buffer: Buffer.from('fpp-tests\n') } },
  });
  expect(r.ok()).toBe(true);
  return r.text();
}

function stored(name: string) {
  return inPlayer('sh', '-c', `test -e '${UPLOADS}/${name}' && echo yes || echo no`).trim() === 'yes';
}

test('server-executable upload types are refused', async ({ request }) => {
  const names = ['fpp-tests.phtml', 'fpp-tests.php7', '.htaccess'];
  try {
    // The control: an ordinary file is stored.
    await upload(request, 'fpp-tests-upload.txt');
    expect(stored('fpp-tests-upload.txt')).toBe(true);

    for (const name of names) {
      expect(await upload(request, name), name).toContain('File type not allowed');
      expect(stored(name), name).toBe(false);
    }
  } finally {
    inPlayer('rm', '-f', ...['fpp-tests-upload.txt', ...names].map((n) => `${UPLOADS}/${n}`));
  }
});
