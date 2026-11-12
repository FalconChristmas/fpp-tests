import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// POST /api/playlist/<name>/<section>/item adds one entry to a section of a
// saved playlist (www/api/controllers/playlist.php PlaylistSectionInsertItem).
// The good path, and the totals it keeps, are in
// playlist-api-stats-locking.spec.ts; this is what it does with a request it
// should not act on.  Each case reads the playlist file afterwards.

test.skip(!container, 'reads and seeds the playlist file inside the run-web.sh container');

const NAME = 'fpp-tests-item-insert';
const FILE = `${MEDIA}/playlists/${NAME}.json`;

const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });

const SEEDED = JSON.stringify({
  name: NAME, version: 4, desc: 'seeded', repeat: 0, loopCount: 0,
  leadIn: [], mainPlaylist: [pause(5)],
  playlistInfo: { total_duration: 5, total_items: 1 },
}, null, 4);

const clean = () => inPlayer('rm', '-f', FILE);
test.beforeEach(() => putFile(FILE, SEEDED));
test.afterEach(clean);

const insert = (request: APIRequestContext, section: string, opts: object) =>
  request.post(`/api/playlist/${NAME}/${section}/item`, opts);

test('an item for a section the file does not have yet starts that section', async ({ request }) => {
  // The seeded file has no leadOut at all.
  const r = await insert(request, 'leadOut', { data: pause(8) });
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ Status: 'OK', Message: '', playlistName: NAME, sectionName: 'leadOut' });
  const stored = JSON.parse(readFile(FILE));
  expect(stored.leadOut).toEqual([pause(8)]);
  expect(stored.mainPlaylist, 'the items already there').toEqual([pause(5)]);
  expect(stored).toMatchObject({ name: NAME, desc: 'seeded' });
  expect(stored.playlistInfo).toMatchObject({ leadOut_items: 1, total_items: 2, total_duration: 13 });
});

test('an item for a playlist that does not exist is refused and creates nothing', async ({ request }) => {
  clean();
  const r = await insert(request, 'mainPlaylist', { data: pause(8) });
  expect(await r.json()).toEqual({ Status: 'Error', Message: 'Playlist does not exist.' });
  expect(exists(FILE)).toBe(false);
});

test('a playlist name that is not a bare file name is refused', async ({ request }) => {
  const r = await request.post('/api/playlist/x%5Cfpp-tests-item-insert/mainPlaylist/item', { data: pause(8) });
  expect(r.status()).toBe(400);
  expect(await r.json()).toEqual({ Status: 'Error', Message: 'Invalid playlist name.' });
  expect(readFile(FILE)).toBe(SEEDED);
});

for (const section of ['bogus', 'playlistInfo', 'name', 'repeat']) {
  test(`"${section}" is not a section: the item is refused and the playlist left as it was`, async ({ request }) => {
    test.fail(true, 'any key of the playlist is taken as a section (FUTURE.md)');
    const r = await insert(request, section, { data: pause(8) });
    const text = await r.text();
    expect(readFile(FILE), `the playlist was rewritten (answer ${r.status()} ${text.slice(0, 200)})`).toBe(SEEDED);
    expect(text).not.toContain('Fatal error');
    expect(JSON.parse(text).Status).toBe('Error');
  });
}

for (const [what, opts] of [
  ['no body', {}],
  ['a body that is not JSON', { data: 'not an entry', headers: { 'Content-Type': 'application/json' } }],
  ['a number for a body', { data: '7', headers: { 'Content-Type': 'application/json' } }],
] as const) {
  test(`${what} is not an item: it is refused and the playlist left as it was`, async ({ request }) => {
    test.fail(true, 'whatever $_POST holds is pushed, an empty array included (FUTURE.md)');
    const r = await insert(request, 'leadIn', opts);
    const text = await r.text();
    expect(readFile(FILE), `the playlist was rewritten (answer ${r.status()} ${text.slice(0, 200)})`).toBe(SEEDED);
    expect(JSON.parse(text).Status).toBe('Error');
  });
}

test('a playlist file that cannot be read as JSON is not replaced by the one new item', async ({ request }) => {
  test.fail(true, 'json_decode failing is not checked: the file is rewritten from nothing (FUTURE.md)');
  // A file cut short, as a full disk or a pulled plug leaves one.
  const cut = SEEDED.slice(0, SEEDED.indexOf('"mainPlaylist"') + 30);
  putFile(FILE, cut);
  const r = await insert(request, 'leadIn', { data: pause(8) });
  const text = await r.text();
  expect(readFile(FILE), `what was left of the playlist is gone (answer ${r.status()} ${text.slice(0, 200)})`).toBe(cut);
  expect(JSON.parse(text).Status).toBe('Error');
});
