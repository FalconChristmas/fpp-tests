import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// GET /api/sequence/:name returns the sequence file, found by name in the
// sequence directory with or without its extension.

test.skip(!container, 'seeds files inside the run-web.sh container');

const SEQ = 'fpp-tests-seqread';
const FILE = `/home/fpp/media/sequences/${SEQ}.fseq`;

test.beforeEach(() => {
  inPlayer('sh', '-c', `printf SEQDATA > ${FILE}`);
});
test.afterEach(() => {
  inPlayer('rm', '-f', FILE);
});

test('a sequence is read by name, with or without its extension', async ({ request }) => {
  // Regression: 71c6d3193.  GetSequence() used $sequence without ever reading
  // it from the route: an undefined variable, so no sequence was ever found.
  for (const name of [SEQ, `${SEQ}.fseq`]) {
    const r = await request.get(`/api/sequence/${name}`);
    expect(r.status(), name).toBe(200);
    expect(await r.text(), name).toBe('SEQDATA');
  }
  expect((await request.get('/api/sequence/fpp-tests-no-such-sequence')).status()).toBe(404);
});
