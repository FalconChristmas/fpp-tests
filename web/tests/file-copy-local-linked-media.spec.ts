import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists } from './settings-file';

// Regression: 6b95a5ddf ("File Copy to and from the local backups folder
// works when media is a link"). copy_settings_to_storage.sh resolved a
// TOLOCAL destination or FROMLOCAL source with realpath and compared it to the
// literal /home/fpp/media/backups, so with the media directory a link every
// path resolved elsewhere and was refused. The test player's media directory
// is a link. (Its image has no rsync, so what is checked is that the copy got
// past the path check and made its folder, not that files were copied.)

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const SETTINGS = `${MEDIA}/settings`;
// A restore sets these whatever it copied; put them back.
const CLEAR = `rm -f /fpp_restored; sed -i '/^BootActions\\s*=/d; s/^rebootFlag\\s*=.*/rebootFlag = "0"/' ${SETTINGS}`;

test('a File Copy to and from the local backups folder takes a plain folder name', async ({ request }) => {
  expect(inPlayer('sh', '-c', `test -L ${MEDIA} && echo link || echo dir`).trim(), 'the media directory is not a link here').toBe('link');
  const dest = `${MEDIA}/backups/fpp-tests-local`;
  try {
    const to = await (await request.get('/copystorage.php?wrapped=1&direction=TOLOCAL&path=fpp-tests-local&flags=Configuration' +
      '&storageLocation=none&remoteStorage=none', { timeout: 120_000 })).text();
    expect(to, 'the destination was refused').not.toContain('Invalid destination path');
    expect(exists(dest), to.slice(-1500)).toBe(true);

    const from = await (await request.get('/copystorage.php?wrapped=1&direction=FROMLOCAL&path=fpp-tests-local&flags=Configuration' +
      '&storageLocation=none&remoteStorage=none', { timeout: 120_000 })).text();
    expect(from, 'the source was refused').not.toContain('Invalid source path');
    // The control: a path out of the folder is still refused.
    const out = await (await request.get('/copystorage.php?wrapped=1&direction=TOLOCAL&path=..%2Fconfig&flags=Configuration' +
      '&storageLocation=none&remoteStorage=none', { timeout: 120_000 })).text();
    expect(out).toContain('Invalid path');
  } finally {
    inPlayer('rm', '-rf', dest);
    inPlayer('sh', '-c', CLEAR);
  }
});
