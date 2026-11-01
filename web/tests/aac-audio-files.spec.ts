import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// An .aac file is an audio file: the upload mover puts it in the music
// folder, and the file API plays it back as audio/aac.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

test('an uploaded .aac file is moved into the music folder', async ({ request }) => {
  // Regression: 9ded4c3ed.  The upload mover's list of audio extensions
  // lacked aac, so an .aac upload was treated as some plugin's file, found
  // no folder, and was left in the upload folder with an error.
  inPlayer('sh', '-c', `echo x > ${MEDIA}/upload/fpp-tests-song.aac`);
  try {
    const r = await request.get('/api/file/move/fpp-tests-song.aac');
    const body = await r.text();
    expect(body).toContain('"OK"');
    expect(exists(`${MEDIA}/music/fpp-tests-song.aac`), body).toBe(true);
    expect(exists(`${MEDIA}/upload/fpp-tests-song.aac`)).toBe(false);
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/upload/fpp-tests-song.aac`, `${MEDIA}/music/fpp-tests-song.aac`);
  }
});

test('an .aac file in the music folder is served as audio/aac', async ({ request }) => {
  // Also 9ded4c3ed: the file API gave an .aac the generic binary type, which
  // an <audio> element will not play.
  inPlayer('sh', '-c', `echo x > ${MEDIA}/music/fpp-tests-song.aac`);
  try {
    const r = await request.get('/api/file/Music/fpp-tests-song.aac?play=1');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe('audio/aac');
  } finally {
    inPlayer('rm', '-f', `${MEDIA}/music/fpp-tests-song.aac`);
  }
});
