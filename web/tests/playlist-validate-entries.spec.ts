import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// What /api/playlists/validate (the Playlists page's warnings) says about a
// playlist before it is played: sub-playlists are checked through, a loop and
// nesting deeper than fppd plays are named, disabled entries are passed over
// as fppd passes over them (a disabled sub-playlist is not: fppd includes it
// anyway), and each kind of entry names what it is missing.

test.skip(!container, 'writes playlist files inside the run-web.sh container');

const P = 'fpp-tests-val-';
const DIR = `${MEDIA}/playlists`;
const PAUSE = { type: 'pause', enabled: 1, playOnce: 0, duration: 1 };
const sub = (name: string, extra: object = {}) => ({ type: 'playlist', enabled: 1, playOnce: 0, name: P + name, ...extra });

let made: string[] = [];
function playlist(name: string, mainPlaylist: object[], leadIn: object[] = []) {
  made.push(P + name);
  putFile(`${DIR}/${P}${name}.json`, JSON.stringify({
    name: P + name, desc: 'fpp-tests', repeat: 0, loopCount: 0, leadIn, mainPlaylist, leadOut: [],
  }));
}
test.beforeEach(() => {
  made = [];
});
test.afterEach(() => {
  for (const n of made) inPlayer('rm', '-f', `${DIR}/${n}.json`);
});

async function validate(request: APIRequestContext) {
  const all: any[] = await (await request.get('/api/playlists/validate')).json();
  return (name: string) => {
    const p = all.find((x) => String(x.name) === P + name);
    expect(p, `${name} in ${JSON.stringify(all.map((x) => x.name))}`).toBeTruthy();
    return p as { valid: boolean; messages: string[]; issues: { section: string; index: number; message: string }[] };
  };
}

test('a sub-playlist is checked through: its problems are counted on the playlist that includes it', async ({ request }) => {
  playlist('good', [PAUSE]);
  playlist('bad', [PAUSE, { type: 'script', enabled: 1, playOnce: 0, scriptName: 'fpp-tests-missing.sh' }]);
  playlist('top', [sub('good'), sub('bad')], [sub('missing')]);
  const v = await validate(request);
  expect(v('good').valid).toBe(true);
  expect(v('bad').messages).toEqual(["Main Playlist #2: Script 'fpp-tests-missing.sh' not found"]);
  expect(v('top').valid).toBe(false);
  expect(v('top').issues).toEqual([
    { section: 'leadIn', index: 0, message: `Playlist '${P}missing' not found` },
    { section: 'mainPlaylist', index: 1, message: `Playlist '${P}bad' has 1 problem` },
  ]);
});

test('a playlist that leads back to itself is named as a loop', async ({ request }) => {
  playlist('a', [sub('b')]);
  playlist('b', [PAUSE, sub('a')]);
  const v = await validate(request);
  // Checked from a: b's entry back to a is the loop, so b has a problem, and a
  // includes a playlist with one.
  expect(v('b').messages).toEqual([`Main Playlist #2: Playlist '${P}a' leads back to this playlist (a loop)`]);
  expect(v('a').messages).toEqual([`Main Playlist #1: Playlist '${P}b' has 1 problem`]);
});

test('sub-playlists nested deeper than fppd plays are reported where it first goes wrong', async ({ request }) => {
  // fppd (Playlist.cpp) includes four levels of sub-playlist and drops a
  // fifth: n0 → n1 → … → n5 loses n5 when n0 is played, but n1 plays whole.
  playlist('n5', [PAUSE]);
  for (let n = 4; n >= 0; n--) playlist(`n${n}`, [sub(`n${n + 1}`)]);
  const v = await validate(request);
  expect(v('n0').messages).toEqual(['Sub-playlists are nested more than 4 levels deep; FPP skips the deepest ones']);
  for (let n = 1; n <= 5; n++) expect(v(`n${n}`).valid, `n${n}`).toBe(true);
  // One more level: the warning moves to the playlist that is now too deep,
  // and the one above says it includes a playlist with a problem.
  playlist('n6', [PAUSE]);
  playlist('n5', [sub('n6')]);
  const w = await validate(request);
  expect(w('n1').messages).toEqual(['Sub-playlists are nested more than 4 levels deep; FPP skips the deepest ones']);
  expect(w('n0').messages).toEqual([`Main Playlist #1: Playlist '${P}n1' has 1 problem`]);
});

test('a disabled entry is not checked, but a disabled sub-playlist is', async ({ request }) => {
  playlist('disabled', [
    { type: 'script', enabled: 0, playOnce: 0, scriptName: 'fpp-tests-missing.sh' },
    { type: 'media', enabled: false, playOnce: 0, mediaName: 'fpp-tests-missing.mp3' },
    sub('missing', { enabled: 0 }),
  ]);
  const v = await validate(request);
  expect(v('disabled').messages).toEqual([`Main Playlist #3: Playlist '${P}missing' not found`]);
});

test('each kind of entry names what it is missing', async ({ request }) => {
  playlist('kinds', [
    { type: 'both', enabled: 1, playOnce: 0, sequenceName: 'fpp-tests-missing.fseq', mediaName: 'fpp-tests-missing.mp3' },
    // A "both" without media plays the sequence alone; a media entry needs one.
    { type: 'both', enabled: 1, playOnce: 0, sequenceName: '', mediaName: '' },
    { type: 'media', enabled: 1, playOnce: 0, mediaName: '' },
    { type: 'media', enabled: 1, playOnce: 0, fileMode: 'random', mediaName: 'ignored-in-random-mode.mp3',
      extraMediaName: 'fpp-tests-extra.mp3', extraMedia: [{ mediaName: 'fpp-tests-extra2.mp3' }, { mediaName: '' }, 'junk'] },
    { type: 'image', enabled: 1, playOnce: 0, imagePath: '' },
    { type: 'script', enabled: 1, playOnce: 0, scriptName: '' },
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'file', dataFile: '/home/fpp/media/fpp-tests-missing.json' },
    // A relative name is opened by fppd from wherever it runs: not checked.
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'file', dataFile: 'relative.json' },
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'plugin', pluginName: 'fpp-tests-no-plugin', pluginHost: '' },
    // A plugin on another host is that host's to have.
    { type: 'dynamic', enabled: 1, playOnce: 0, subType: 'plugin', pluginName: 'fpp-tests-no-plugin', pluginHost: '192.0.2.1' },
    { type: 'branch', enabled: 1, playOnce: 0, trueNextBranchType: 'Playlist', trueBranchPlaylist: '',
      falseNextBranchType: 'Index', falseBranchPlaylist: 'ignored' },
    { type: 'fpp-tests-kind', enabled: 1, playOnce: 0 },
    { type: 'remap', enabled: 1, playOnce: 0 },
    { type: 'url', enabled: 1, playOnce: 0 },
  ]);
  const v = await validate(request);
  expect(v('kinds').messages).toEqual([
    "Main Playlist #1: Sequence 'fpp-tests-missing.fseq' not found",
    "Main Playlist #1: Media 'fpp-tests-missing.mp3' not found",
    'Main Playlist #2: No sequence selected',
    'Main Playlist #3: No media selected',
    "Main Playlist #4: Extra media 'fpp-tests-extra.mp3' not found",
    "Main Playlist #4: Extra media 'fpp-tests-extra2.mp3' not found",
    'Main Playlist #5: No image selected',
    'Main Playlist #6: No script selected',
    "Main Playlist #7: Dynamic data file '/home/fpp/media/fpp-tests-missing.json' not found",
    "Main Playlist #9: Plugin 'fpp-tests-no-plugin' is not installed",
    'Main Playlist #11: No branch playlist selected',
    "Main Playlist #12: Unknown entry type 'fpp-tests-kind'",
  ]);
});

test('a playlist file that is not JSON is reported as unreadable, and one including it as having a problem', async ({ request }) => {
  made.push(`${P}broken`);
  putFile(`${DIR}/${P}broken.json`, '{"name": "fpp-tests-val-broken", "mainPlaylist": [');
  playlist('uses-broken', [sub('broken')]);
  const v = await validate(request);
  expect(v('broken').messages).toEqual(['Playlist file could not be read']);
  expect(v('uses-broken').messages).toEqual([`Main Playlist #1: Playlist '${P}broken' has 1 problem`]);
});
