import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Cancelling an upload in the file manager calls DELETE /api/file/uploads/
// with no file name.  The upload directory is where in-flight uploads live, so
// the delete is refused outright, saying why ("Invalid parameters"), and the
// directory and what is in it stay.
//
// Regression: b0414fd94 ("Prevent cancelled uploads from deleting the uploads
// directory entirely").  The empty name resolved to the directory itself,
// which was emptied and removed.  Its explicit refusal is what gives the
// status text asserted here; the later "refusing to delete the whole
// directory" check (5551d12b1, see file-delete-empty-name.spec.ts) also keeps
// the files but answers with a different status.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const UPLOAD = '/home/fpp/media/upload';

test('a delete with no name on the upload directory is refused as invalid parameters', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${UPLOAD} && echo keep > ${UPLOAD}/fpp-tests-partial.bin`);
  try {
    for (const key of ['uploads', 'upload']) {
      const r = await request.delete(`/api/file/${key}/`);
      const body = await r.json();
      expect(body.status, `DELETE /api/file/${key}/: ${r.status()} ${JSON.stringify(body)}`).toBe('Invalid parameters');
      expect(inPlayer('sh', '-c', `test -e ${UPLOAD}/fpp-tests-partial.bin && echo there || echo gone`).trim()).toBe('there');
    }
    // The control: a named file in the same directory is still deleted.
    const named = await request.delete('/api/file/uploads/fpp-tests-partial.bin');
    expect((await named.json()).status).toBe('OK');
    expect(inPlayer('sh', '-c', `test -e ${UPLOAD}/fpp-tests-partial.bin && echo there || echo gone`).trim()).toBe('gone');
  } finally {
    inPlayer('sh', '-c', `rm -f ${UPLOAD}/fpp-tests-partial.bin`);
  }
});
