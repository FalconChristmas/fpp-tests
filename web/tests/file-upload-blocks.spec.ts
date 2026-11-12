import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, docker, inPlayer } from './container';
import { MEDIA, putFile } from './settings-file';

// POST /api/file/<dir>/<name>: the body is the file, or with ?sb=<block>&bs=
// <block size> one block of it, written at sb * bs into the file as it stands
// (www/api/controllers/files.php PostFile).  The file is read back from the
// player after each request.

test.skip(!container, 'reads the uploaded file inside the run-web.sh container');

const NAME = 'fpp-tests-blocks.bin';
const FILE = `${MEDIA}/upload/${NAME}`;
const SEQ = 'fpp-tests-blocks.fseq';
const SEQ_FILE = `${MEDIA}/sequences/${SEQ}`;

// The file as hex, so a hole reads as 00 rather than as nothing.
const hex = (path: string) => inPlayer('sh', '-c', `od -An -v -tx1 "${path}" | tr -d ' \\n'`).trim();
const asHex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

const clean = () => inPlayer('sh', '-c', `rm -f -- "${FILE}" "${SEQ_FILE}" "${SEQ_FILE}".*`);
test.beforeEach(clean);
test.afterEach(clean);

const post = (request: APIRequestContext, query: string, data: string, name = `uploads/${NAME}`) =>
  request.post(`/api/file/${name}${query}`, { data, headers: { 'Content-Type': 'application/octet-stream' } });

test('blocks sent one request each land at their own place in the file, in any order', async ({ request }) => {
  // Block 0 creates the file.
  let r = await post(request, '?sb=0&bs=4', 'AAAA');
  expect(await r.json()).toEqual({ status: 'OK', file: NAME, dir: 'uploads', written: '4', size: '4', offset: '0' });
  expect(hex(FILE)).toBe(asHex('AAAA'));

  // Block 2 before block 1: a hole is left for it.
  r = await post(request, '?sb=2&bs=4', 'CCCC');
  expect(await r.json()).toMatchObject({ status: 'OK', written: '4', size: '12', offset: '8' });
  expect(hex(FILE)).toBe(asHex('AAAA') + '00000000' + asHex('CCCC'));

  r = await post(request, '?sb=1&bs=4', 'BBBB');
  expect(await r.json()).toMatchObject({ status: 'OK', written: '4', size: '8', offset: '4' });
  expect(hex(FILE)).toBe(asHex('AAAABBBBCCCC'));

  // A block sent again replaces only itself: nothing after it is cut off.
  r = await post(request, '?sb=0&bs=4', 'aaaa');
  expect(r.status()).toBe(200);
  expect(hex(FILE)).toBe(asHex('aaaaBBBBCCCC'));

  // A short last block.
  r = await post(request, '?sb=3&bs=4', 'D');
  expect(await r.json()).toMatchObject({ status: 'OK', written: '1', size: '13', offset: '12' });
  expect(hex(FILE)).toBe(asHex('aaaaBBBBCCCCD'));
});

test('an upload with no block number replaces the whole file', async ({ request }) => {
  putFile(FILE, 'a longer file than the one that replaces it');
  const r = await post(request, '', 'SHORT');
  expect(await r.json()).toEqual({ status: 'OK', file: NAME, dir: 'uploads', written: '5', size: '5', offset: 0 });
  expect(hex(FILE)).toBe(asHex('SHORT'));
});

for (const [what, query] of [
  ['a block number with no block size', '?sb=2'],
  ['a negative block number', '?sb=-1&bs=4'],
  ['a block number that is not a number', '?sb=abc&bs=4'],
  ['a block size of 0', '?sb=2&bs=0'],
] as const) {
  test(`${what} is refused, not written over the start of the file`, async ({ request }) => {
    test.fail(true, 'sb and bs are multiplied unchecked: the block goes to offset 0, or bcmul() throws (FUTURE.md)');
    putFile(FILE, 'AAAABBBBCCCC');
    const r = await post(request, query, 'zz');
    const text = await r.text();
    expect(hex(FILE), `the file was changed (answer ${r.status()} ${text.slice(0, 160)})`).toBe(asHex('AAAABBBBCCCC'));
    expect(text).not.toContain('Fatal error');
    expect(r.status()).toBeGreaterThanOrEqual(400);
  });
}

// fppd holds a shared flock on the sequence it is playing.  A shared lock
// held by another process stands in for it (see sequence-api-upload.spec.ts).
test('an upload over a sequence fppd has locked does not empty it while it waits', async ({ request }) => {
  test.fail(true, 'the file is opened with "w", which empties it, before the lock is asked for (FUTURE.md)');
  putFile(SEQ_FILE, 'ORIGINAL');
  docker('exec', '-d', container, 'flock', '-s', SEQ_FILE, 'sleep', '19.47');
  const release = () => inPlayer('sh', '-c', 'pkill -f "sleep 19[.]47" || true');
  let pending: Promise<unknown> | undefined;
  try {
    await expect.poll(() => inPlayer('sh', '-c', `flock -n -x "${SEQ_FILE}" true && echo free || echo held`).trim(),
      { timeout: 5_000 }).toBe('held');
    pending = post(request, '', 'NEW VERSION', `sequences/${SEQ}`).catch(() => undefined);
    // Long enough for the request to have opened the file.
    await new Promise((res) => setTimeout(res, 1500));
    expect(hex(SEQ_FILE), 'the locked sequence was emptied under its reader').toBe(asHex('ORIGINAL'));
  } finally {
    release();
    await pending;
  }
});

test('the control: the same upload over a sequence nothing holds replaces it', async ({ request }) => {
  putFile(SEQ_FILE, 'ORIGINAL');
  const r = await post(request, '', 'NEW VERSION', `sequences/${SEQ}`);
  expect(await r.json()).toMatchObject({ status: 'OK', file: SEQ, dir: 'sequences', written: '11' });
  expect(hex(SEQ_FILE)).toBe(asHex('NEW VERSION'));
});
