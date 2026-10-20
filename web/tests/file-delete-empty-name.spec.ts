import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// DELETE /api/file/<dir>/<name> deletes a file or a subdirectory of a media
// directory, never the media directory itself.  Before fpp 5551d12b1
// ("fix(api): deleting a file with an empty name no longer removes its
// directory"), an empty name or "." resolved to the directory, which passed
// the containment check and went to removeDir(): every sequence gone.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const SEQ = '/home/fpp/media/sequences';

// "." itself never reaches the player: the URL parser drops a "." or "%2e"
// segment.  "%252e" arrives at the controller as ".".
for (const [label, name] of [['an empty name', ''], ['"."', '%252e']]) {
  test(`a delete with ${label} leaves the directory and its files`, async ({ request }) => {
    inPlayer('sh', '-c', `mkdir -p ${SEQ} && echo keep > ${SEQ}/fpp-tests-keep.fseq`);
    try {
      const r = await request.delete(`/api/file/sequences/${name}`);
      const body = await r.text();
      expect(inPlayer('sh', '-c', `test -e ${SEQ}/fpp-tests-keep.fseq && echo there || echo gone`).trim(),
        `DELETE /api/file/sequences/${name}: ${r.status()} ${body}`).toBe('there');
      expect(body).not.toMatch(/"status"\s*:\s*"OK"/);
    } finally {
      inPlayer('sh', '-c', `mkdir -p ${SEQ} && rm -f ${SEQ}/fpp-tests-keep.fseq`);
    }
  });
}
