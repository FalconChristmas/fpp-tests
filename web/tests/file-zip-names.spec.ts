import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';
import { putFile } from './settings-file';

// Regression: 6327a9130 ("include hostname in downloaded zip filenames").  A
// folder downloaded as a zip (the File Manager's Zip, the support zip of
// logs and config) was named FPP_<what>_<date>.<time>.zip whichever player
// it came from.  It is now <HostName>_<what>_<date>_<time>.zip, with the
// host name cut down to letters, digits and '-' (it reaches a header, and a
// hand edit of the settings file isn't validated).

test.skip(!container, 'sets the host name in the settings file inside the run-web.sh container');

const SCRIPT = '/home/fpp/media/scripts/fpp-tests-zip-name.sh';

test('a downloaded zip is named for the host it came from', async ({ request }) => {
  // Also ee8f49b50: any folder of the media directory (Scripts here) can be
  // downloaded as a zip; a folder the zip doesn't know is answered with a
  // status, not a download.
  putFile(SCRIPT, '#!/bin/sh\necho fpp-tests\n');
  try {
    await keepingSettings(async () => {
      setSettingInFile('HostName', 'FPP-tests.zip!host');
      const r = await request.get('/api/files/zip/Scripts');
      expect(r.status()).toBe(200);
      const disposition = r.headers()['content-disposition'] ?? '';
      expect(disposition).toMatch(/^attachment;\s*filename="?FPP-testsziphost_Scripts_\d{8}_\d{4}\.zip"?$/);
      // The receiving end: what is sent is a zip holding the folder.
      const body = await r.body();
      expect(body.subarray(0, 2).toString()).toBe('PK');
      expect(body.includes(Buffer.from('fpp-tests-zip-name.sh'))).toBe(true);

      // With no usable host name the name still leads with something.
      setSettingInFile('HostName', '!!!');
      const r2 = await request.get('/api/files/zip/Scripts');
      expect(r2.headers()['content-disposition']).toMatch(/filename="?FPP_Scripts_\d{8}_\d{4}\.zip"?$/);
    });
  } finally {
    inPlayer('rm', '-f', SCRIPT);
  }
});

test('a comma-separated list of folders is zipped together as "all"', async ({ request }) => {
  // Feature: 3854dad2c.  /api/files/zip/<A>,<B> puts every named folder in one
  // zip, named "all", instead of only the first.
  const playlist = '/home/fpp/media/playlists/fpp-tests-zip-all.json';
  putFile(SCRIPT, '#!/bin/sh\necho fpp-tests\n');
  putFile(playlist, '{}');
  try {
    const r = await request.get('/api/files/zip/Scripts,Playlists');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-disposition'] ?? '').toMatch(/_all_\d{8}_\d{4}\.zip"?$/);
    const body = await r.body();
    expect(body.subarray(0, 2).toString()).toBe('PK');
    expect(body.includes(Buffer.from('Scripts/fpp-tests-zip-name.sh')), 'the first folder is missing').toBe(true);
    expect(body.includes(Buffer.from('Playlists/fpp-tests-zip-all.json')), 'the second folder is missing').toBe(true);
  } finally {
    inPlayer('rm', '-f', SCRIPT, playlist);
  }
});
