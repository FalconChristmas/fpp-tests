import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer } from './container';

// A chunked upload (PATCH /api/file/<dir>, FilePond and xLights) over a file
// that is in use.  A sequence fppd has open is kept aside as <name>.replace
// (fseq-upload-while-playing.spec.ts); any other file that is locked (a song
// fppd is playing holds it) is refused, left as it was, and the chunks are
// kept so that the retry of the last chunk finishes the upload once the file
// is free.  A shared flock held by `flock -s` stands in for the player.

test.skip(!container, 'checks the uploaded files inside the run-web.sh container');

const MUSIC = '/home/fpp/media/music';
const NAME = 'fpp-tests-locked-upload.mp3';
const CHUNK = 32 * 1024;
const OLD = Buffer.alloc(1000, 0x11);

function payload(chunks: number): Buffer {
  const b = Buffer.alloc(CHUNK * chunks);
  for (let i = 0; i < b.length; i++) b[i] = (i * 5 + Math.floor(i / CHUNK) * 11) & 0xff;
  return b;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const shaInPlayer = () => inPlayer('sh', '-c', `sha256sum "${MUSIC}/${NAME}" | cut -d' ' -f1`).trim();
const leftovers = () => inPlayer('sh', '-c', `cd ${MUSIC} && ls -A`).split('\n').filter((f) => f.startsWith(NAME) && f !== NAME);

function chunk(request: APIRequestContext, offset: number, length: number, body: Buffer) {
  return request.patch('/api/file/music?patch=fpp-tests', {
    headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Name': NAME,
      'Upload-Offset': String(offset), 'Upload-Length': String(length) },
    data: body,
  });
}

async function hold() {
  docker('exec', '-d', container, 'flock', '-s', `${MUSIC}/${NAME}`, 'sleep', '23.47');
  await expect.poll(() => inPlayer('sh', '-c', `flock -n -x "${MUSIC}/${NAME}" true && echo free || echo held`).trim(),
    { timeout: 5_000 }).toBe('held');
}
const release = () => inPlayer('sh', '-c', 'pkill -f "sleep 23[.]47" || true');

test.beforeEach(() => {
  inPlayer('sh', '-c', `printf '%s' '${OLD.toString('base64')}' | base64 -d > "${MUSIC}/${NAME}"`);
});
test.afterEach(() => {
  release();
  inPlayer('sh', '-c', `cd ${MUSIC} && rm -f -- "${NAME}" "${NAME}".*`);
});

test('a locked song is refused and left as it was, and the retry finishes once it is free', async ({ request }) => {
  const data = payload(3);
  await hold();
  try {
    for (let i = 0; i < 2; i++) {
      const r = await chunk(request, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK));
      expect(r.status()).toBe(200);
    }
    const last = await chunk(request, 2 * CHUNK, data.length, data.subarray(2 * CHUNK));
    expect(last.status()).toBe(500);
    expect(await last.json()).toMatchObject({ status: 'failed', file: NAME, error: 'Could not lock file for writing' });
    // The song in use is untouched, and nothing is kept aside for it.
    expect(shaInPlayer()).toBe(sha(OLD));
    expect(leftovers().filter((f) => f.endsWith('.replace'))).toEqual([]);
  } finally {
    release();
  }

  // FilePond retries the chunk that failed: with the file free, it assembles.
  await expect.poll(() => inPlayer('sh', '-c', `flock -n -x "${MUSIC}/${NAME}" true && echo free || echo held`).trim()).toBe('free');
  const retry = await chunk(request, 2 * CHUNK, data.length, data.subarray(2 * CHUNK));
  expect(retry.status(), await retry.text()).toBe(200);
  expect(await retry.json()).toMatchObject({ status: 'OK', file: NAME, size: String(data.length) });
  expect(shaInPlayer()).toBe(sha(data));
  expect(leftovers()).toEqual([]);
});

test('an unlocked song is replaced whole', async ({ request }) => {
  const data = payload(2);
  for (let i = 0; i < 2; i++) {
    const r = await chunk(request, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK));
    expect(r.status()).toBe(200);
  }
  expect(shaInPlayer()).toBe(sha(data));
  expect(leftovers()).toEqual([]);
});
