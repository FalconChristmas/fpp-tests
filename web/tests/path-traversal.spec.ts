import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Playlist, sequence and upload names are single path components: no request
// reaches a file outside its own directory, however the name is encoded.
//
// A name that reaches a route as one URL segment is decoded more than once on
// the way: Apache (once), the api rewrite's [B] escaping undone by PHP, then
// limonade, then whatever the controller decodes itself.  "%25252f" survives
// as a single segment up to the controller and turns into "/" there.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
// "../config/<name>" with the separators encoded deep enough to stay one segment.
const deep = (name: string) => `..%25252fconfig%25252f${name}`;

function exists(path: string): boolean {
  return inPlayer('sh', '-c', `test -e '${path}' && echo yes || echo no`).trim() === 'yes';
}

function seed(path: string, body: string) {
  inPlayer('sh', '-c', `printf '%s' '${body}' > '${path}' && chmod 666 '${path}'`);
}

test('a playlist created with "../" in its name is refused', async ({ request }) => {
  // Regression: ea99f2a0c.  playlist_insert() wrote playlists/<name>.json with
  // the body's "name" unchecked, so any *.json path, config/ included, could be
  // written with the caller's JSON.
  const target = `${MEDIA}/config/fpp-tests-pl-insert.json`;
  try {
    const r = await request.post('/api/playlists', { data: { name: '../config/fpp-tests-pl-insert', mainPlaylist: [] } });
    expect(exists(target), `POST /api/playlists wrote ${target}: ${r.status()} ${await r.text()}`).toBe(false);
    expect(r.status()).toBeGreaterThanOrEqual(400);
    // Control: a plain name is still saved, where it belongs.
    const ok = await request.post('/api/playlists', { data: { name: 'fpp-tests-pl-ok', mainPlaylist: [] } });
    expect(ok.ok(), await ok.text()).toBe(true);
    expect(exists(`${MEDIA}/playlists/fpp-tests-pl-ok.json`)).toBe(true);
  } finally {
    inPlayer('rm', '-f', target, `${MEDIA}/playlists/fpp-tests-pl-ok.json`);
  }
});

test('a playlist saved through an encoded "../" URL stays in playlists', async ({ request }) => {
  // Regression: ea99f2a0c.  playlist_update() rawurldecode()d the name the
  // router had already decoded, so a separator one level deeper reached the
  // path it wrote to.
  const target = `${MEDIA}/config/fpp-tests-pl-update.json`;
  try {
    const r = await request.post(`/api/playlist/${deep('fpp-tests-pl-update')}`, { data: { name: 'x', mainPlaylist: [] } });
    expect(exists(target), `POST /api/playlist/... wrote ${target}: ${r.status()} ${await r.text()}`).toBe(false);
  } finally {
    inPlayer('rm', '-f', target);
  }
});

test('a sequence read through an encoded "../" URL is refused', async ({ request }) => {
  // Regression: ea99f2a0c.  findFile() tried decoded variants of the name and
  // returned one that existed, outside the sequence directory too.
  const target = `${MEDIA}/config/fpp-tests-seq.fseq`;
  seed(target, 'FPP-TESTS-OUTSIDE-SEQUENCES');
  try {
    const r = await request.get(`/api/sequence/${deep('fpp-tests-seq')}`);
    const body = await r.text();
    expect(body, 'the file outside sequences/ was served').not.toContain('FPP-TESTS-OUTSIDE-SEQUENCES');
    expect(r.status()).not.toBe(200);
  } finally {
    inPlayer('rm', '-f', target);
  }
});

test('a file move with an encoded "../" name moves nothing from outside upload', async ({ request }) => {
  // Regression: 1782a56e7.  MoveFile() took findFile()'s decoded variant, and
  // every destination is built by concatenation: a config file outside
  // upload/ was renamed onto config/cape-eeprom.bin.
  const target = `${MEDIA}/config/fpp-tests-mv-eeprom.bin`;
  seed(target, 'fpp-tests');
  try {
    // GET: the route had no POST before 10.3.
    const r = await request.get(`/api/file/move/${deep('fpp-tests-mv-eeprom.bin')}`);
    const body = await r.text();
    expect(exists(target), `the file outside upload/ was moved: ${r.status()} ${body}`).toBe(true);
    expect(exists(`${MEDIA}/config/cape-eeprom.bin`), 'cape-eeprom.bin was written').toBe(false);
  } finally {
    inPlayer('rm', '-f', target, `${MEDIA}/config/cape-eeprom.bin`);
  }
});
