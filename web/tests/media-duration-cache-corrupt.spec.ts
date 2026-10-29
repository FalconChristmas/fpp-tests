import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { putFile, readFile } from './settings-file';

// config/media_durations.cache holds each media file's probed length, keyed
// by name and checked against the file's size; the File Manager, the
// playlist editor and fppd (for files TagLib can't time) read it.
//
// Regression: cc17ddfe0 ("If the media_duration.cache files becomes
// unparsable or corrupt, remove it and recreate").  A cache that failed to
// decode came back from json_decode() as null, and the lookup's
// array_key_exists() on it threw: every duration request answered 500 until
// someone deleted the file by hand.

test.skip(!container, 'seeds a song and the cache inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const CACHE = `${MEDIA}/config/media_durations.cache`;
const SONG = 'fpp-tests-cache.wav';
const SECONDS = 3;

// A 3 s, 8 kHz mono 16-bit WAV of silence.
function wav(): Buffer {
  const rate = 8000;
  const samples = rate * SECONDS;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

test.beforeEach(() => {
  // Piped in: docker cp doesn't follow the media directory's symlink.
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'sh', `${MEDIA}/music/${SONG}`],
    { input: wav(), stdio: ['pipe', 'ignore', 'pipe'] });
});

test.afterEach(() => {
  inPlayer('rm', '-f', `${MEDIA}/music/${SONG}`, CACHE);
});

for (const [what, content] of [['cut short', '{"other.mp3": {"filesize": 12, "dura'], ['empty', ''], ['not an object', '"x"']]) {
  test(`a duration cache that is ${what} is replaced, not fatal`, async ({ request }) => {
    putFile(CACHE, content);
    const dur = await request.get(`/api/media/${SONG}/duration`);
    expect(dur.status(), await dur.text()).toBe(200);
    const body = await dur.text();
    expect(body, 'PHP died answering it').not.toMatch(/Fatal error|Uncaught/);
    expect(Number((await dur.json())[SONG]?.duration)).toBeCloseTo(SECONDS, 1);

    // The cache was written again, whole, with this song in it.
    const cache = JSON.parse(readFile(CACHE));
    expect(Number(cache[SONG]?.duration)).toBeCloseTo(SECONDS, 1);
    expect(Number(cache[SONG]?.filesize)).toBe(wav().length);

    // The receiving end: the next lookup is answered from the rewritten
    // cache (an entry changed by hand comes back), not by probing again.
    cache[SONG].duration = 42;
    putFile(CACHE, JSON.stringify(cache));
    const again = await request.get(`/api/media/${SONG}/duration`);
    expect(again.status()).toBe(200);
    expect(Number((await again.json())[SONG]?.duration)).toBe(42);
  });
}
