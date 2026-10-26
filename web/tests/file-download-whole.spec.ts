import { test, expect } from './fixtures';
import http from 'http';
import { createHash } from 'crypto';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, putFile } from './settings-file';

// The player's downloads as they leave Apache, read as raw HTTP (node's http,
// which shows the transfer encoding and asks for no compression), not through
// a client that hides how the body came.
//
// None carries a Content-Length: since Apache 2.4.59, mod_proxy_fcgi drops
// the one a FastCGI reply sets (the CVE-2024-24795 fix), so a PHP download
// goes out chunked.  b3c72029b and 57cefd230 removed the headers PHP set for
// nothing.  What is worth guarding is that each one arrives whole and framed
// right: every byte of the file, and nothing after the body, so a second
// request on the same kept-alive connection is answered.  These are
// regression guards; dropping a header Apache never sent can't make them red.

test.skip(!container, 'puts files in the run-web.sh container');

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; reusedSocket: boolean };

function get(agent: http.Agent, base: string, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(path, base), { agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), reusedSocket: req.reusedSocket }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// The download, then a second request on the same connection.
async function downloadWhole(base: string, path: string, want: { size: number; sha: string }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const r = await get(agent, base, path);
    expect(r.status, r.body.toString().slice(0, 200)).toBe(200);
    expect(r.body.length, 'bytes received').toBe(want.size);
    expect(sha(r.body), 'the bytes are not the file').toBe(want.sha);
    expect(r.headers['transfer-encoding']).toBe('chunked');
    expect(r.headers['content-length']).toBeUndefined();
    const next = await get(agent, base, '/api/system/info');
    expect(next.reusedSocket, 'the connection was not kept for a second request').toBe(true);
    expect(next.status).toBe(200);
    expect(JSON.parse(next.body.toString())).toHaveProperty('Version');
  } finally {
    agent.destroy();
  }
}

// Larger than any buffer on the way, and not a round number.
const SIZE = 3 * 1024 * 1024 + 17;

test('a file from the file API arrives whole and framed', async ({ baseURL }) => {
  const file = `${MEDIA}/upload/fpp-tests-whole.bin`;
  try {
    inPlayer('sh', '-c', `head -c ${SIZE} /dev/urandom > ${file}`);
    await downloadWhole(baseURL!, '/api/file/Uploads/fpp-tests-whole.bin',
      { size: SIZE, sha: inPlayer('sha256sum', file).split(' ')[0] });
  } finally {
    inPlayer('rm', '-f', file);
  }
});

test('a sequence download arrives whole and framed', async ({ baseURL }) => {
  const file = `${MEDIA}/sequences/fpp-tests-whole.fseq`;
  try {
    inPlayer('sh', '-c', `head -c ${SIZE} /dev/urandom > ${file}`);
    await downloadWhole(baseURL!, '/api/sequence/fpp-tests-whole.fseq',
      { size: SIZE, sha: inPlayer('sha256sum', file).split(' ')[0] });
  } finally {
    inPlayer('rm', '-f', file);
  }
});

test.describe('a backup rebuilt from its blobs on the way out', () => {
  const NAME = 'fpp-tests-whole-backup.json';
  const blob = JSON.stringify(Array.from({ length: 40000 }, (_, i) => `${i},0,0,0,fpp-tests display map line`));
  const hash = sha(blob);
  const missing = 'f'.repeat(64);
  const whole = `{"backup_comment":"fpp-tests","virtualdisplaymap":${blob}}`;
  test.beforeEach(() => {
    inPlayer('mkdir', '-p', `${BACKUPS}/blobs`);
    putFile(`${BACKUPS}/blobs/${hash}.json`, blob);
    putFile(`${BACKUPS}/${NAME}`, `{"backup_comment":"fpp-tests","virtualdisplaymap":{"__fppBlob":{"sha256":"${hash}"}}}`);
  });
  test.afterEach(() => inPlayer('rm', '-f', `${BACKUPS}/${NAME}`, `${BACKUPS}/blobs/${hash}.json`));

  for (const path of [`/api/file/JsonBackups/${NAME}`, `/api/backups/configuration/JsonBackups/${NAME}`]) {
    test(`arrives whole and framed from ${path.split('/').slice(0, 3).join('/')}`, async ({ baseURL }) => {
      await downloadWhole(baseURL!, path, { size: Buffer.byteLength(whole), sha: sha(whole) });
    });
  }

  test('that cannot be rebuilt is a 500, not a 200 with the error in it', async ({ baseURL }) => {
    // Regression: b3c72029b.  GetFileImpl() flushed the headers before this
    // branch set its 500, which then changed nothing: the error text went
    // out as a 200 attachment, a download that looked as if it had worked.
    putFile(`${BACKUPS}/${NAME}`, `{"backup_comment":"fpp-tests","virtualdisplaymap":{"__fppBlob":{"sha256":"${missing}"}}}`);
    const agent = new http.Agent();
    const r = await get(agent, baseURL!, `/api/file/JsonBackups/${NAME}`);
    agent.destroy();
    expect(r.body.toString()).toContain(`Unable to rebuild backup ${NAME}: blob ${missing} is missing`);
    expect(r.status).toBe(500);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
  });
});
