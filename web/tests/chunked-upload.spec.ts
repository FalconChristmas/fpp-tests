import net from 'net';
import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';

// FilePond's chunked upload, as the File Manager sends it: a POST to
// api/file/upload for a transfer id, then one PATCH per chunk with
// Upload-Name, Upload-Offset and Upload-Length.  FilePond retries a chunk
// that failed or got no answer, so the server has to take the same chunk
// twice, a body cut off part way, and a retry of a chunk whose upload has
// already finished.
//
// Fixed in fpp 83273b626 ("fix(upload): make chunked uploads safe against
// retries, cut-off bodies and path tricks").  PatchFile() appended each body
// to the patch files as it came: a retried chunk was counted twice and
// assembled into a corrupt file; a cut-off body was appended anyway, so the
// patch sizes never added up and the upload hung; a '[' in the name was read
// as a glob pattern and the patches were never found; Upload-Offset went into
// a file name unchecked ("0/../../x" wrote outside upload/); a late retry of
// the final chunk left a stray patch behind.

test.skip(!container, 'checks the uploaded files inside the run-web.sh container');

const UPLOAD = '/home/fpp/media/upload';
const CHUNK = 64 * 1024;

// Three chunks that differ, so a chunk counted twice or out of place changes the file.
function payload(chunks: number): Buffer {
  const b = Buffer.alloc(CHUNK * chunks);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + Math.floor(i / CHUNK) * 13) & 0xff;
  return b;
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function shaInPlayer(name: string): string {
  return inPlayer('sh', '-c', `sha256sum "${UPLOAD}/${name}" 2>/dev/null | cut -d' ' -f1 || true`).trim();
}

function leftovers(name: string): string[] {
  return inPlayer('sh', '-c', `cd ${UPLOAD} && ls -A`).split('\n').filter((f) => f.startsWith(name) && f !== name);
}

async function start(request: APIRequestContext): Promise<string> {
  const r = await request.post('/api/file/upload');
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.text()).trim();
}

function chunk(request: APIRequestContext, id: string, name: string, offset: number | string, length: number, body: Buffer) {
  return request.patch(`/api/file/upload?patch=${encodeURIComponent(id)}`, {
    headers: {
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Name': name,
      'Upload-Offset': String(offset),
      'Upload-Length': String(length),
    },
    data: body,
  });
}

// A PATCH whose connection closes after `sent` of its bytes, as a browser
// that lost the network part way through a chunk leaves it.
function cutOffChunk(name: string, offset: number, length: number, body: Buffer, sent: number): Promise<void> {
  const base = new URL(test.info().project.use.baseURL!);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(base.port || 80), base.hostname, () => {
      s.write(
        `PATCH /api/file/upload?patch=x HTTP/1.1\r\nHost: ${base.host}\r\n` +
        `Content-Type: application/offset+octet-stream\r\nUpload-Name: ${name}\r\n` +
        `Upload-Offset: ${offset}\r\nUpload-Length: ${length}\r\nContent-Length: ${body.length}\r\n` +
        `Connection: close\r\n\r\n`);
      s.write(body.subarray(0, sent), () => setTimeout(() => { s.destroy(); resolve(); }, 300));
    });
    s.on('error', reject);
  });
}

function clean(name: string) {
  inPlayer('sh', '-c', `cd ${UPLOAD} && rm -f -- "${name}" "${name}".*`);
}

test('each upload start is given its own transfer id', async ({ request }) => {
  // Regression: e09bf47e7.  The POST that starts an upload answered "OK"
  // for everyone; FilePond uses the answer as the transfer's id, and macOS
  // uploads of several files at once ran into each other's chunks.
  const a = await start(request);
  const b = await start(request);
  expect(a).not.toBe('OK');
  expect(a).not.toBe(b);
});

test('a retried middle chunk is not counted twice', async ({ request }) => {
  const name = 'fpp-tests-dup.bin';
  const data = payload(3);
  clean(name);
  try {
    const id = await start(request);
    for (const i of [0, 1, 1, 2]) {
      const r = await chunk(request, id, name, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK));
      expect(r.ok(), `chunk ${i}: ${await r.text()}`).toBe(true);
    }
    expect(shaInPlayer(name), 'the assembled file').toBe(sha(data));
    expect(leftovers(name)).toEqual([]);
  } finally {
    clean(name);
  }
});

test('a chunk cut off part way is thrown away and its retry completes the upload', async ({ request }) => {
  const name = 'fpp-tests-cut.bin';
  const data = payload(3);
  clean(name);
  try {
    const id = await start(request);
    expect((await chunk(request, id, name, 0, data.length, data.subarray(0, CHUNK))).ok()).toBe(true);
    await cutOffChunk(name, CHUNK, data.length, data.subarray(CHUNK, 2 * CHUNK), CHUNK / 2);
    // The cut-off request is finished with once its private part file is gone.
    await expect.poll(() => leftovers(name).filter((f) => f.includes('.upload-')), { timeout: 10_000 }).toEqual([]);
    for (const i of [1, 2]) {
      const r = await chunk(request, id, name, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK));
      expect(r.ok(), `chunk ${i}: ${await r.text()}`).toBe(true);
    }
    expect(shaInPlayer(name), 'the upload never completed, or completed corrupt').toBe(sha(data));
    expect(leftovers(name)).toEqual([]);
  } finally {
    clean(name);
  }
});

test('a name with [ and ] in it completes', async ({ request }) => {
  // Also d8795d89b: the patches of a name with square brackets were looked up
  // with a pattern the brackets broke, so the upload never finished.
  const name = 'fpp-tests [remix].bin';
  const data = payload(2);
  clean(name);
  try {
    const id = await start(request);
    for (const i of [0, 1]) {
      const r = await chunk(request, id, name, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK));
      expect(r.ok(), `chunk ${i}: ${await r.text()}`).toBe(true);
    }
    expect(shaInPlayer(name)).toBe(sha(data));
    expect(leftovers(name)).toEqual([]);
  } finally {
    clean(name);
  }
});

test('an Upload-Offset holding a path is refused and writes nothing outside upload', async ({ request }) => {
  const name = 'fpp-tests-offset.bin';
  const escaped = '/home/fpp/media/fpp-tests-escaped';
  inPlayer('rm', '-f', escaped);
  clean(name);
  try {
    const id = await start(request);
    const r = await chunk(request, id, name, '0/../../fpp-tests-escaped', CHUNK, payload(1));
    expect(inPlayer('sh', '-c', `test -e ${escaped} && echo written || echo none`).trim(),
      `the chunk was written outside upload/ (${r.status()} ${await r.text()})`).toBe('none');
    expect(r.status()).toBe(400);
  } finally {
    inPlayer('rm', '-f', escaped);
    clean(name);
  }
});

test('a late retry of the final chunk is answered OK and leaves nothing behind', async ({ request }) => {
  const name = 'fpp-tests-late.bin';
  const data = payload(2);
  clean(name);
  try {
    const id = await start(request);
    for (const i of [0, 1]) {
      expect((await chunk(request, id, name, i * CHUNK, data.length, data.subarray(i * CHUNK, (i + 1) * CHUNK))).ok()).toBe(true);
    }
    expect(shaInPlayer(name)).toBe(sha(data));

    const late = await chunk(request, id, name, CHUNK, data.length, data.subarray(CHUNK));
    expect(late.status(), await late.text()).toBe(200);
    expect(shaInPlayer(name)).toBe(sha(data));
    expect(leftovers(name), 'a stray patch from the late retry').toEqual([]);

    // A mid-file chunk for an upload that is not in progress at all.
    const stray = 'fpp-tests-stray.bin';
    clean(stray);
    try {
      const r = await chunk(request, id, stray, CHUNK, data.length, data.subarray(CHUNK));
      expect(r.status(), await r.text()).toBe(409);
      expect(leftovers(stray)).toEqual([]);
    } finally {
      clean(stray);
    }
  } finally {
    clean(name);
  }
});
