import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// Uploading a new version of the sequence fppd is playing, as xLights does
// with its chunked upload (one PATCH here, the whole file).  fppd holds a
// shared flock on the sequence it has open; the upload sees the lock and
// writes <name>.replace instead of rewriting the file under the player; fppd
// swaps the new file in when it closes the sequence.
//
//  - fpp 6df874021: fppd takes the shared lock on the open sequence (an
//    upload used to overwrite the file being read, and fppd crashed);
//  - fpp da56526bf: the upload keeps a locked sequence as <name>.replace
//    (it failed with "Could not lock file for writing") and fppd swaps it in
//    when the sequence is closed or next opened.

test.skip(!container, 'checks the sequence files inside the run-web.sh container');

const SEQ_DIR = '/home/fpp/media/sequences';
const NAME = 'fpp-tests-replace.fseq';
const PLAYLIST = 'fpp-tests-replace';

// An uncompressed FSEQ v1 file: 512 channels of `value`, 50 ms frames.
function fseq(frames: number, value: number): Buffer {
  const channels = 512;
  const h = Buffer.alloc(28);
  h.write('PSEQ', 0, 'latin1');
  h.writeUInt16LE(28, 4);        // channel data offset
  h.writeUInt8(0, 6);            // minor
  h.writeUInt8(1, 7);            // major
  h.writeUInt16LE(28, 8);        // header length
  h.writeUInt32LE(channels, 10);
  h.writeUInt32LE(frames, 14);
  h.writeUInt8(50, 18);          // step ms
  h.writeUInt8(1, 24);           // gamma
  h.writeUInt8(2, 25);           // colour encoding
  return Buffer.concat([h, Buffer.alloc(channels * frames, value)]);
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const shaInPlayer = (path: string) =>
  inPlayer('sh', '-c', `sha256sum "${path}" 2>/dev/null | cut -d' ' -f1 || true`).trim();

async function upload(request: APIRequestContext, data: Buffer) {
  const id = (await (await request.post('/api/file/sequences')).text()).trim();
  return request.patch(`/api/file/sequences?patch=${encodeURIComponent(id)}`, {
    headers: {
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Name': NAME,
      'Upload-Offset': '0',
      'Upload-Length': String(data.length),
    },
    data,
  });
}

async function fppdStatus(request: APIRequestContext) {
  return (await request.get('/api/fppd/status')).json();
}

function clean() {
  inPlayer('sh', '-c', `rm -f -- "${SEQ_DIR}/${NAME}" "${SEQ_DIR}/${NAME}".*`);
}

test('a new version of the playing sequence is kept aside and swapped in when it stops', async ({ request }) => {
  const v1 = fseq(400, 0x11);   // 20 s
  const v2 = fseq(40, 0x22);
  clean();
  try {
    expect((await upload(request, v1)).ok()).toBe(true);
    expect(shaInPlayer(`${SEQ_DIR}/${NAME}`)).toBe(sha(v1));
    const pl = await request.post(`/api/playlist/${PLAYLIST}`, {
      data: {
        name: PLAYLIST, version: 4, repeat: 0, loopCount: 0, leadIn: [], leadOut: [],
        mainPlaylist: [{ type: 'sequence', enabled: 1, playOnce: 0, sequenceName: NAME }],
        playlistInfo: {},
      },
    });
    expect(pl.ok()).toBe(true);
    expect((await request.get(`/api/playlist/${PLAYLIST}/start`)).ok()).toBe(true);
    await expect.poll(async () => (await fppdStatus(request)).current_sequence,
      { timeout: 10_000 }).toBe(NAME);

    // While it plays: the upload succeeds, the playing file is untouched and
    // the new one waits beside it.
    const up = await upload(request, v2);
    expect(up.status(), await up.text()).toBe(200);
    expect(shaInPlayer(`${SEQ_DIR}/${NAME}`), 'the playing sequence was rewritten').toBe(sha(v1));
    expect(shaInPlayer(`${SEQ_DIR}/${NAME}.replace`), 'no .replace beside the playing sequence').toBe(sha(v2));
    expect((await fppdStatus(request)).current_sequence).toBe(NAME);

    // Stopping closes the sequence, and fppd swaps the new version in.
    await request.get('/api/playlists/stop');
    await expect.poll(async () => (await fppdStatus(request)).status_name, { timeout: 10_000 }).toBe('idle');
    await expect.poll(() => shaInPlayer(`${SEQ_DIR}/${NAME}`), { timeout: 5_000 }).toBe(sha(v2));
    expect(shaInPlayer(`${SEQ_DIR}/${NAME}.replace`), 'the .replace was left behind').toBe('');
  } finally {
    await request.get('/api/playlists/stop');
    await request.delete(`/api/playlist/${PLAYLIST}`);
    clean();
  }
});
