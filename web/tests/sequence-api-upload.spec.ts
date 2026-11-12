import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import { container, docker, inPlayer } from './container';
import { MEDIA, exists, putFile } from './settings-file';
import { fseqV2 } from './fseq';

// POST /api/sequence/<name>: the request body is the sequence file
// (www/api/controllers/sequence.php PostSequence).  A name without an
// extension is an .fseq in the sequence directory, an .eseq goes to the
// effects directory, and the name is only ever a file directly in one of them.

test.skip(!container, 'checks the files inside the run-web.sh container');

const SEQ_DIR = `${MEDIA}/sequences`;
const EFF_DIR = `${MEDIA}/effects`;
const NAME = 'fpp-tests-sequp';
const FILE = `${SEQ_DIR}/${NAME}.fseq`;

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const shaInPlayer = (path: string) =>
  inPlayer('sh', '-c', `sha256sum "${path}" 2>/dev/null | cut -d' ' -f1 || true`).trim();
const listed = (dir: string) => inPlayer('sh', '-c', `ls -A "${dir}" | grep -i fpp-tests-sequp || true`).trim();

function clean() {
  // find, not a shell glob: one of the names starts with a dot.
  inPlayer('sh', '-c', `find "${MEDIA}" "${SEQ_DIR}" "${EFF_DIR}" -maxdepth 1 -name '*fpp-tests-sequp*' -exec rm -rf -- {} +`);
}
test.beforeEach(clean);
test.afterEach(clean);

test('an uploaded sequence is stored byte for byte, read back, described and deleted', async ({ request }) => {
  const data = fseqV2({ stepMs: 50, channels: 64, frames: 40 });
  const up = await request.post(`/api/sequence/${NAME}`, { data, headers: { 'Content-Type': 'application/octet-stream' } });
  expect(up.status(), await up.text()).toBe(200);
  expect(await up.json()).toEqual({ Status: 'OK', Message: '' });
  expect(shaInPlayer(FILE), 'the file in the sequence directory').toBe(sha(data));

  const back = await request.get(`/api/sequence/${NAME}`);
  expect(sha(await back.body())).toBe(sha(data));
  expect((await (await request.get('/api/sequence')).json())).toContain(NAME);

  const meta = await (await request.get(`/api/sequence/${NAME}/meta`)).json();
  expect(meta).toMatchObject({ Name: `${NAME}.fseq`, NumFrames: 40, StepTime: 50, ChannelCount: 64 });

  // A second upload under the same name (here with the extension) replaces it.
  const v2 = fseqV2({ stepMs: 25, channels: 32, frames: 10 });
  expect((await request.post(`/api/sequence/${NAME}.fseq`, { data: v2 })).status()).toBe(200);
  expect(shaInPlayer(FILE)).toBe(sha(v2));
  expect(listed(SEQ_DIR), 'one file, not one per spelling').toBe(`${NAME}.fseq`);

  const del = await request.delete(`/api/sequence/${NAME}`);
  expect(del.status()).toBe(200);
  expect(exists(FILE)).toBe(false);
});

test('an .eseq is stored in the effects directory, not with the sequences', async ({ request }) => {
  const data = Buffer.from('fpp-tests effect body');
  expect((await request.post(`/api/sequence/${NAME}.eseq`, { data })).status()).toBe(200);
  expect(shaInPlayer(`${EFF_DIR}/${NAME}.eseq`)).toBe(sha(data));
  expect(listed(SEQ_DIR)).toBe('');

  expect(sha(await (await request.get(`/api/sequence/${NAME}.eseq`)).body())).toBe(sha(data));
  expect((await request.delete(`/api/sequence/${NAME}.eseq`)).status()).toBe(200);
  expect(exists(`${EFF_DIR}/${NAME}.eseq`)).toBe(false);
});

test('a name that is not a bare file name writes nothing outside the sequence directory', async ({ request }) => {
  // A backslash is refused outright.
  const bad = await request.post(`/api/sequence/x%5Cfpp-tests-sequp`, { data: 'X' });
  expect(bad.status()).toBe(400);
  expect(await bad.json()).toEqual({ Status: 'Error', Message: 'Invalid sequence name.' });

  // A doubly-encoded "../" reaches the controller as the text "..%2F": it is
  // one file name in the sequence directory, never a step out of it.
  const r = await request.post(`/api/sequence/..%252Ffpp-tests-sequp-out`, { data: 'X' });
  expect([200, 400]).toContain(r.status());
  expect(listed(MEDIA), 'a file was written beside the sequence directory').toBe('');
  if (r.status() === 200) {
    expect(listed(SEQ_DIR)).toBe('..%2Ffpp-tests-sequp-out.fseq');
  } else {
    expect(listed(SEQ_DIR)).toBe('');
  }
});

// fppd holds a shared flock on the sequence it is playing, and the chunked
// upload (PATCH /api/file/sequences) honours it: the new version waits as
// <name>.replace (fseq-upload-while-playing.spec.ts).  A shared lock held by
// another process stands in for fppd here, so no test rewrites a file fppd is
// really reading.
async function withSharedLock(file: string, body: () => Promise<void>) {
  docker('exec', '-d', container, 'flock', '-s', file, 'sleep', '17.31');
  try {
    await expect.poll(() => inPlayer('sh', '-c', `flock -n -x "${file}" true && echo free || echo held`).trim(),
      { timeout: 5_000 }).toBe('held');
    await body();
  } finally {
    // "[.]" so the pattern does not match the shell that carries it.
    inPlayer('sh', '-c', 'pkill -f "sleep 17[.]31" || true');
  }
}

test('the control: an upload replaces a sequence nothing has open', async ({ request }) => {
  putFile(FILE, 'ORIGINAL');
  const r = await request.post(`/api/sequence/${NAME}`, { data: 'NEW VERSION' });
  expect(r.status()).toBe(200);
  expect(shaInPlayer(FILE)).toBe(sha('NEW VERSION'));
  expect(exists(`${FILE}.replace`)).toBe(false);
});

test('an upload does not rewrite a sequence fppd has locked', async ({ request }) => {
  test.fail(true, 'PostSequence opens the file with "w" whatever holds it (FUTURE.md)');
  putFile(FILE, 'ORIGINAL');
  await withSharedLock(FILE, async () => {
    const r = await request.post(`/api/sequence/${NAME}`, { data: 'NEW VERSION' });
    // Either answer is sound: kept aside as .replace for fppd to swap in (what
    // the chunked upload does), or refused.  Rewriting the open file is not.
    expect(shaInPlayer(FILE), 'the locked sequence was rewritten in place').toBe(sha('ORIGINAL'));
    if (r.status() === 200) {
      expect(shaInPlayer(`${FILE}.replace`)).toBe(sha('NEW VERSION'));
    } else {
      expect(exists(`${FILE}.replace`)).toBe(false);
    }
  });
});

test('an upload with no body does not empty the sequence it names', async ({ request }) => {
  test.fail(true, 'PostSequence truncates before it has read anything, and says OK (FUTURE.md)');
  putFile(FILE, 'ORIGINAL');
  const r = await request.post(`/api/sequence/${NAME}`);
  expect(shaInPlayer(FILE), `the sequence was emptied (answer ${r.status()} ${await r.text()})`).toBe(sha('ORIGINAL'));
  expect(r.status()).toBeGreaterThanOrEqual(400);
});

test('an upload that cannot be written is reported as an error', async ({ request }) => {
  test.fail(true, 'fopen() is not checked: a PHP fatal goes out with a 200 (FUTURE.md)');
  // A directory where the file would go: the one write failure a root player
  // can stage.
  inPlayer('mkdir', '-p', FILE);
  const r = await request.post(`/api/sequence/${NAME}`, { data: 'X' });
  const text = await r.text();
  expect(text, 'a PHP error went out as the answer').not.toContain('Fatal error');
  expect(r.status()).toBeGreaterThanOrEqual(400);
  expect(JSON.parse(text).Status).toBe('Error');
});

test('the control: a failed upload leaves the answer for a good one alone', async ({ request }) => {
  // Beside the test above: with the directory out of the way the same request
  // is stored and answered as JSON.
  const r = await request.post(`/api/sequence/${NAME}`, { data: 'X' });
  expect(r.status()).toBe(200);
  expect(JSON.parse(await r.text()).Status).toBe('OK');
  expect(shaInPlayer(FILE)).toBe(sha('X'));
});
