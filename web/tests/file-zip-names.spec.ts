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
