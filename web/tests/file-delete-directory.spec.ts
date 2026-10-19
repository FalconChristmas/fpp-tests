import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// DELETE /api/file/<dir>/<name> only ever removes something inside a media
// directory. A directory key that maps to none -- "plugins", or any unknown
// key -- is refused.
//
// Before fpp 4bbcfcf21 ("fix(api): a file delete in a directory key that maps to
// nothing is refused"), DeleteFile() went on with an empty directory:
// realpath("") is PHP's working directory (www/api under php-fpm), which then
// served as the containment base, so DELETE /api/file/plugins/opt/fpp/www/api/...
// removed FPP's own files.

test.skip(!container, 'creates and checks a directory inside the run-web.sh container');

const victim = '/opt/fpp/www/api/fpp-tests-delete-me';

for (const key of ['plugins', 'fpp-tests-no-such-dir']) {
  test(`a delete under the "${key}" key cannot reach outside the media directories`, async ({ request }) => {
    inPlayer('sh', '-c', `mkdir -p ${victim} && echo keep > ${victim}/keep.txt`);
    try {
      const r = await request.delete(`/api/file/${key}${victim}`);
      const body = await r.text();
      expect(r.status(), `DELETE /api/file/${key}${victim}: ${body}`).toBeGreaterThanOrEqual(400);
      expect(inPlayer('sh', '-c', `test -e ${victim}/keep.txt && echo there || echo gone`).trim(),
        'the directory outside the media directories').toBe('there');
    } finally {
      inPlayer('rm', '-rf', victim);
    }
  });
}
