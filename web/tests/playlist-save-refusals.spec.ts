import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// POST /api/playlist/<name> is the playlist editor's Save: the body replaces
// the playlist file (www/api/controllers/playlist.php playlist_update).  What
// it does with a request that carries no playlist, and with a name that is
// not one.  The playlist file is read back after every request.

test.skip(!container, 'seeds and reads the playlist file inside the run-web.sh container');

const NAME = 'fpp-tests-save-refusals';
const FILE = `${MEDIA}/playlists/${NAME}.json`;
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });
const SEEDED = JSON.stringify({
  name: NAME, version: 4, desc: 'the show', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: [pause(5), pause(6)], leadOut: [],
  playlistInfo: { total_duration: 11, total_items: 2 },
}, null, 4);
const raw = (body: string) => ({ data: Buffer.from(body), headers: { 'Content-Type': 'application/json' } });

const clean = () => inPlayer('sh', '-c', `rm -f -- "${MEDIA}"/playlists/*fpp-tests-save-refusals* "${MEDIA}"/*fpp-tests-save-refusals*`);
test.beforeEach(() => { clean(); putFile(FILE, SEEDED); });
test.afterEach(clean);

test('the control: a save replaces the playlist with what was posted, and keeps its totals', async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, { data: {
    name: NAME, version: 4, desc: 'changed', repeat: 1, loopCount: 0, leadIn: [pause(2)], mainPlaylist: [pause(9)], leadOut: [],
  } });
  expect(r.status()).toBe(200);
  const stored = JSON.parse(readFile(FILE));
  expect(stored).toMatchObject({ name: NAME, desc: 'changed', repeat: 1, leadIn: [pause(2)], mainPlaylist: [pause(9)], leadOut: [] });
  expect(stored.playlistInfo).toMatchObject({ leadIn_items: 1, mainPlaylist_items: 1, total_items: 2, total_duration: 11 });
});

test('a name with a path in it is refused for a save, a create and a delete', async ({ request }) => {
  const bad = `x%5C${NAME}`;
  for (const r of [
    await request.post(`/api/playlist/${bad}`, { data: { name: 'x', mainPlaylist: [] } }),
    await request.delete(`/api/playlist/${bad}`),
    await request.post('/api/playlists', { data: { name: `..\\${NAME}`, mainPlaylist: [] } }),
    await request.post('/api/playlists', { data: { mainPlaylist: [] } }),
  ]) {
    expect(r.status(), r.url()).toBe(400);
    expect(await r.json(), r.url()).toEqual({ Status: 'Error', Message: 'Invalid playlist name.' });
  }
  // A read of such a name finds nothing.
  expect((await request.get(`/api/playlist/${bad}`)).status()).toBe(404);
  expect(readFile(FILE)).toBe(SEEDED);
  expect(inPlayer('sh', '-c', `ls -A "${MEDIA}" "${MEDIA}/playlists" | grep -c save-refusals || true`).trim(), 'only the seeded file').toBe('1');
});

test('deleting a playlist that is not there says so, and deleting one removes it', async ({ request }) => {
  let r = await request.delete(`/api/playlist/${NAME}-none`);
  expect(await r.json()).toEqual({ Status: 'Error', Message: `Playlist '${NAME}-none' does not exist.` });
  expect(exists(FILE)).toBe(true);
  r = await request.delete(`/api/playlist/${NAME}`);
  expect(await r.json()).toEqual({ Status: 'OK', Message: '' });
  expect(exists(FILE)).toBe(false);
});

for (const [what, opts] of [
  ['no body', {}],
  ['a body cut short', raw(SEEDED.slice(0, 120))],
  ['a body that is a number', raw('7')],
] as const) {
  test(`a save with ${what} does not empty the playlist`, async ({ request }) => {
    const r = await request.post(`/api/playlist/${NAME}`, opts);
    expect(readFile(FILE), `the playlist was replaced (answer ${r.status()} ${(await r.text()).slice(0, 120)})`).toBe(SEEDED);
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });
}

test('a save whose sections are not lists is refused as a bad playlist', async ({ request }) => {
  const r = await request.post(`/api/playlist/${NAME}`, { data: { name: NAME, leadIn: 5, mainPlaylist: 'all of it' } });
  const text = await r.text();
  expect(readFile(FILE), 'the control: this one is not written').toBe(SEEDED);
  expect(text).not.toContain('Fatal error');
  expect(r.status()).toBe(400);
});
