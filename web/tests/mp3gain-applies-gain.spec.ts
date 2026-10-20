import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// The File Manager's MP3Gain button ran a bare "mp3gain <files>", which only
// measures and tags: the audio was never changed.  Fixed in fpp 15bf1db67
// ("fix(filemanager): MP3Gain applies the gain instead of only analyzing"),
// which passes -r (apply track gain) and -k (turn a clipping track down
// rather than stop to ask).
//
// mp3gain is a stub here that records how it was run.

const STUB = '/usr/local/bin/mp3gain';
const ARGS = '/tmp/fpp-tests-mp3gain.args';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('MP3Gain is run to apply the gain', async ({ request }) => {
  inPlayer('sh', '-c', `printf '#!/bin/sh\\necho "$*" > ${ARGS}\\n' > ${STUB} && chmod 755 ${STUB} && rm -f ${ARGS}`);
  try {
    const r = await request.post('/run_mp3gain.php', { data: ['fpp-tests.mp3'] });
    expect(r.ok()).toBe(true);
    const args = inPlayer('sh', '-c', `cat ${ARGS} 2>/dev/null || true`).trim();
    // The control: the stub ran, on the file asked for.
    expect(args).toContain('fpp-tests.mp3');
    expect(args.split(/\s+/)).toEqual(expect.arrayContaining(['-r', '-k']));
  } finally {
    inPlayer('rm', '-f', STUB, ARGS);
  }
});
