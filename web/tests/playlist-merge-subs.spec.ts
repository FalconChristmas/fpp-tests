import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// GET /api/playlist/<name>?mergeSubs=1 (LoadPlayListDetails() and
// LoadSubPlaylist()), which the Status page asks for when a playlist is
// picked, to show what it will play: each sub-playlist entry is replaced, in
// place, by that playlist's lead in, main and lead out entries, its own
// sub-playlists in turn replaced too.

test.skip(!container, 'writes playlist files inside the run-web.sh container');

const P = 'fpp-tests-merge-';
const DIR = `${MEDIA}/playlists`;
const pause = (duration: number) => ({ type: 'pause', enabled: 1, playOnce: 0, duration });
const sub = (name: string) => ({ type: 'playlist', enabled: 1, playOnce: 0, name: P + name });

let made: string[] = [];
function playlist(name: string, sections: { leadIn?: object[]; mainPlaylist?: object[]; leadOut?: object[] }) {
  made.push(P + name);
  putFile(`${DIR}/${P}${name}.json`, JSON.stringify({
    name: P + name, desc: 'fpp-tests', repeat: 0, loopCount: 0, leadIn: [], mainPlaylist: [], leadOut: [], ...sections,
  }));
}
test.beforeEach(() => {
  made = [];
});
test.afterEach(() => {
  for (const n of made) inPlayer('rm', '-f', `${DIR}/${n}.json`);
});

const durations = (entries: any[]) => entries.map((e) => (e.type === 'pause' ? e.duration : `${e.type}:${e.name}`));

test('sub-playlists are merged in place, all their sections, nested ones too', async ({ request, page }) => {
  playlist('inner', { leadIn: [pause(31)], mainPlaylist: [pause(32)], leadOut: [pause(33)] });
  playlist('middle', { mainPlaylist: [pause(21), sub('inner'), pause(22)] });
  playlist('top', {
    leadIn: [pause(1), sub('inner')],
    mainPlaylist: [pause(2), sub('middle'), pause(3), sub('inner')],
    leadOut: [sub('middle')],
  });
  const merged = await (await request.get(`/api/playlist/${P}top?mergeSubs=1`)).json();
  expect(durations(merged.leadIn)).toEqual([1, 31, 32, 33]);
  expect(durations(merged.mainPlaylist)).toEqual([2, 21, 31, 32, 33, 22, 3, 31, 32, 33]);
  expect(durations(merged.leadOut)).toEqual([21, 31, 32, 33, 22]);
  // Without mergeSubs the playlist is as saved.
  const plain = await (await request.get(`/api/playlist/${P}top`)).json();
  expect(durations(plain.mainPlaylist)).toEqual([2, `playlist:${P}middle`, 3, `playlist:${P}inner`]);

  // The Status page lists what will play.
  await page.goto('/index.php');
  await page.locator('#playlistSelect').selectOption({ label: `${P}top` });
  await expect(page.locator('#tblPlaylistMainPlaylist tr:has(td)')).toHaveCount(10);
  await expect(page.locator('#tblPlaylistLeadOut tr:has(td)')).toHaveCount(5);
});

// LoadSubPlaylist() stops at fppd's depth: a playlist that leads back to
// itself (the validator names it a loop) is merged as far as fppd would play
// it, and the reply is the merged playlist.
test('a playlist that leads back to itself still comes back merged, as far as fppd would play it', async ({ request }) => {
  playlist('a', { mainPlaylist: [pause(1), sub('b')] });
  playlist('b', { mainPlaylist: [pause(2), sub('a')] });
  const r = await request.get(`/api/playlist/${P}a?mergeSubs=1`);
  const body = await r.text();
  expect(body, 'the reply is PHP\'s fatal error').not.toContain('Allowed memory size');
  const merged = JSON.parse(body);
  expect(merged.mainPlaylist.length).toBeGreaterThan(1);
});
