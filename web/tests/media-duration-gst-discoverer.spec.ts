import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// With no ffprobe on the player, a song's duration and metadata come from
// GStreamer's gst-discoverer-1.0 (which FPP_Install.sh installs), parsed into
// ffprobe's shape.  Regression: 999e4c239.  ffprobe was the only probe, so
// on a GStreamer-only install api/media/<name>/meta had no format.duration
// and api/media/<name>/duration answered 404 -- the playlist editor and the
// File Manager showed no length for any song.

test.skip(!container, 'seeds a song inside the run-web.sh container');

const MEDIA = '/home/fpp/media';
const SONG = 'fpp-tests-discoverer.wav';
const SECONDS = 7;

// A 7 s, 8 kHz mono 16-bit WAV of silence.
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
  inPlayer('rm', '-f', `${MEDIA}/config/media_durations.cache`);
});

test.afterEach(() => {
  inPlayer('rm', '-f', `${MEDIA}/music/${SONG}`, `${MEDIA}/config/media_durations.cache`);
});

test('a song with no ffprobe to read it gets its length from gst-discoverer', async ({ request }) => {
  // The fallback is what is under test: no ffprobe here, the real
  // gst-discoverer-1.0 is.
  expect(inPlayer('sh', '-c', 'command -v ffprobe || echo none').trim()).toBe('none');
  expect(inPlayer('sh', '-c', 'command -v gst-discoverer-1.0 || echo none').trim()).not.toBe('none');

  const meta = await request.get(`/api/media/${SONG}/meta`);
  expect(meta.status()).toBe(200);
  const body = await meta.json();
  expect(Number(body?.format?.duration), JSON.stringify(body)).toBeCloseTo(SECONDS, 1);
  expect((body?.streams ?? []).map((s: any) => s.codec_type), JSON.stringify(body)).toContain('audio');

  const dur = await request.get(`/api/media/${SONG}/duration`);
  expect(dur.status(), await dur.text()).toBe(200);
  expect(Number((await dur.json())[SONG]?.duration)).toBeCloseTo(SECONDS, 1);
});
