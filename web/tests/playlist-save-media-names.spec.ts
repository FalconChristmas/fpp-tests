import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Saving a playlist whose media names carry characters that the stored file
// does not: an upload strips them from the file name (sanitizeFilename), and a
// client such as xLights' FPP Connect saves the playlist under the name it
// had before.  The save points each item at the file that exists, and leaves
// a name alone when its own file exists or no file does.

test.skip(!container, 'puts media files in the run-web.sh container');

const MEDIA = '/home/fpp/media';
const FILES = [`${MEDIA}/sequences/Joy to the World.fseq`, `${MEDIA}/music/Silent Night (live).mp3`, `${MEDIA}/images/Snow Flake.png`];
const EXACT = `${MEDIA}/sequences/Hark! Herald.fseq`;
const NAMES = ['fpp-tests media names', 'fpp-tests media names, updated'];

test.beforeEach(() => {
  for (const f of [...FILES, EXACT]) inPlayer('sh', '-c', `touch '${f}'`);
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', ...FILES, EXACT);
  for (const n of NAMES) await request.delete(`/api/playlist/${encodeURIComponent(n)}`);
});

const entries = () => [
  { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: 'Joy to the World!.fseq' },
  { type: 'media', enabled: 1, playOnce: 0, mediaName: 'Silent Night (live)?.mp3' },
  { type: 'image', enabled: 1, playOnce: 0, imagePath: 'Snow: Flake.png', imageDirectory: 'x' },
  // The file with exactly this name exists: nothing to change.
  { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: 'Hark! Herald.fseq' },
  // No file by either name: left as sent.
  { type: 'sequence', enabled: 1, playOnce: 0, sequenceName: 'Not Uploaded!.fseq' },
];

const SAVED = ['Joy to the World.fseq', 'Silent Night (live).mp3', 'Snow Flake.png', 'Hark! Herald.fseq', 'Not Uploaded!.fseq'];

function names(section: any[]) {
  return section.map((e) => e.sequenceName ?? e.mediaName ?? e.imagePath);
}

test('a playlist created through the API names the files that exist, not the name they were uploaded under', async ({ request }) => {
  // Regression: 807a5cb6c (#1103, #1104).  The names went into the playlist as
  // sent, so a sequence or song uploaded as "Name!.fseq" and stored as
  // "Name.fseq" was a playlist entry that never played.
  const r = await request.post('/api/playlists', { data: { name: NAMES[0], desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: entries(), leadOut: entries().slice(0, 1) } });
  expect(r.ok(), `POST /api/playlists: ${r.status()} ${await r.text()}`).toBe(true);
  const got = await (await request.get(`/api/playlist/${encodeURIComponent(NAMES[0])}`)).json();
  expect(names(got.mainPlaylist)).toEqual(SAVED);
  expect(names(got.leadOut), 'every section is cleaned').toEqual([SAVED[0]]);
  // The receiving end: each saved name that was cleaned is a file the player has.
  const present = inPlayer('sh', '-c', `cd ${MEDIA} && ls sequences music images`).split('\n');
  for (const n of SAVED.slice(0, 4)) expect(present, n).toContain(n);
});

test('an updated playlist is cleaned the same way, under a name given percent-encoded', async ({ request }) => {
  // Regression: 807a5cb6c.  The update did the same (and takes the playlist's
  // name from the URL, where a space or comma is encoded).
  const url = `/api/playlist/${encodeURIComponent(NAMES[1])}`;
  const r = await request.post(url, { data: { name: NAMES[1], desc: '', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: entries(), leadOut: [] } });
  expect(r.ok(), `POST ${url}: ${r.status()} ${await r.text()}`).toBe(true);
  const got = await request.get(url);
  expect(got.status(), 'the playlist is found under its decoded name').toBe(200);
  expect(names((await got.json()).mainPlaylist)).toEqual(SAVED);
  expect(inPlayer('ls', `${MEDIA}/playlists`).split('\n')).toContain(`${NAMES[1]}.json`);
});
