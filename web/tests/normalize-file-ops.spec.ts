import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { exists, putFile, readFile } from './settings-file';

// Normalize stores each song's gain in config/media_gain.json, keyed by its
// name in the music folder ("videos/<name>" for a video). A rename, copy or
// delete in the File Manager keeps that file in step.
//
// Before fpp 96ba50ee5 ("Normalize: entries follow rename, copy and
// delete"), the entries stayed under the old names: a renamed song played
// un-normalized until it was measured again, and a deleted one left an entry
// that nothing would ever match.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MEDIA = '/home/fpp/media';
const GAINS = `${MEDIA}/config/media_gain.json`;
const P = 'fpp-tests-norm';

function entry(gainDb: number) {
  return { gainDb, size: 4 };
}

function gains(): Record<string, { gainDb: number }> {
  return JSON.parse(readFile(GAINS));
}

function keys(): string[] {
  return Object.keys(gains()).filter((k) => k.includes(P)).sort();
}

test.beforeEach(() => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/music/${P}-dir && for f in ${MEDIA}/music/${P}-a.mp3 ${MEDIA}/music/${P}-b.mp3 ` +
    `${MEDIA}/music/${P}-dir/c.mp3 ${MEDIA}/music/${P}-dirx.mp3 ${MEDIA}/videos/${P}-v.mp4; do printf abcd > "$f"; done`);
  putFile(GAINS, JSON.stringify({
    [`${P}-a.mp3`]: entry(-1),
    [`${P}-b.mp3`]: entry(-2),
    [`${P}-dir/c.mp3`]: entry(-3),
    [`${P}-dirx.mp3`]: entry(-4),
    [`videos/${P}-v.mp4`]: entry(-5),
  }));
});

test.afterEach(() => {
  inPlayer('sh', '-c', `rm -rf ${GAINS} ${MEDIA}/music/${P}* ${MEDIA}/videos/${P}*`);
});

test('a renamed song keeps its normalization', async ({ request }) => {
  const r = await request.post(`/api/file/music/rename/${P}-a.mp3/${P}-a2.mp3`);
  expect((await r.json()).status).toBe('success');
  const g = gains();
  expect(g[`${P}-a2.mp3`]?.gainDb, 'the new name has the entry').toBe(-1);
  expect(g[`${P}-a.mp3`], 'the old name has none').toBeUndefined();
});

test('a renamed video keeps its normalization', async ({ request }) => {
  const r = await request.post(`/api/file/videos/rename/${P}-v.mp4/${P}-w.mp4`);
  expect((await r.json()).status).toBe('success');
  expect(keys()).toContain(`videos/${P}-w.mp4`);
  expect(keys()).not.toContain(`videos/${P}-v.mp4`);
});

test('a copy of a song is normalized like the original', async ({ request }) => {
  const r = await request.post(`/api/file/music/copy/${P}-b.mp3/${P}-b2.mp3`);
  expect((await r.json()).status).toBe('success');
  const g = gains();
  expect(g[`${P}-b.mp3`]?.gainDb).toBe(-2);
  expect(g[`${P}-b2.mp3`]?.gainDb).toBe(-2);
});

test("renaming over a normalized song doesn't leave its entry on the new file", async ({ request }) => {
  putFile(`${MEDIA}/music/${P}-new.mp3`, 'abcd');
  const r = await request.post(`/api/file/music/rename/${P}-new.mp3/${P}-a.mp3`);
  expect((await r.json()).status).toBe('success');
  expect(gains()[`${P}-a.mp3`], 'the replaced song measured, not this one').toBeUndefined();
});

test('deleting a song removes its entry', async ({ request }) => {
  const r = await request.delete(`/api/file/music/${P}-b.mp3`);
  expect((await r.json()).status).toBe('OK');
  expect(keys()).toEqual([`${P}-a.mp3`, `${P}-dir/c.mp3`, `${P}-dirx.mp3`, `videos/${P}-v.mp4`]);
});

test('deleting a folder removes the entries inside it, and only those', async ({ request }) => {
  const r = await request.delete(`/api/file/music/${P}-dir`);
  expect((await r.json()).status).toBe('OK');
  expect(keys()).toEqual([`${P}-a.mp3`, `${P}-b.mp3`, `${P}-dirx.mp3`, `videos/${P}-v.mp4`]);
});

test("a delete doesn't create media_gain.json on a player that never normalized", async ({ request }) => {
  inPlayer('rm', '-f', GAINS);
  const r = await request.delete(`/api/file/music/${P}-b.mp3`);
  expect((await r.json()).status).toBe('OK');
  expect(exists(GAINS)).toBe(false);
});
