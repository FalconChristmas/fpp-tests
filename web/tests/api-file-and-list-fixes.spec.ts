import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// Small fixes to the file and list endpoints of the API, each with a fixture
// seeded in the player's media directory.

test.skip(!container, 'seeds and checks files inside the run-web.sh container');

const MEDIA = '/home/fpp/media';

function seed(rel: string, content = 'x') {
  inPlayer('sh', '-c', `mkdir -p "$(dirname ${MEDIA}/${rel})" && printf %s '${content}' > "${MEDIA}/${rel}"`);
}
function remove(...rels: string[]) {
  inPlayer('rm', '-rf', ...rels.map((r) => `${MEDIA}/${r}`));
}

// 81354db8f: a file no plugin handles is answered, not left blank.
test('file info for a plugin that does not exist says so', async ({ request }) => {
  const r = await request.get('/api/file/info/nosuchplugin/ext/x.ext');
  expect((await r.text())).toMatch(/Could not find information for file x\.ext/);
});

// 99b25c30d: asking for a directory as if it were a file is refused.
test('a file download with no file name is not a 200', async ({ request }) => {
  const r = await request.get('/api/file/sequences/');
  expect(r.status()).toBeGreaterThanOrEqual(400);
  seed('sequences/fpp-tests-sub/placeholder.txt');
  try {
    const sub = await request.get('/api/file/sequences/fpp-tests-sub');
    expect(sub.status()).toBe(404);
  } finally {
    remove('sequences/fpp-tests-sub');
  }
});

// a3e3c24c8: name-only file lists are alphabetical.
test('a name-only file list is sorted', async ({ request }) => {
  for (const n of ['fpp-tests-b.txt', 'fpp-tests-a.txt', 'fpp-tests-c.txt']) seed(`scripts/${n}`);
  try {
    const r = await request.get('/api/files/scripts?nameOnly=1');
    const names: string[] = (await r.json()).filter((n: string) => n.startsWith('fpp-tests-'));
    expect(names).toEqual(['fpp-tests-a.txt', 'fpp-tests-b.txt', 'fpp-tests-c.txt']);
  } finally {
    remove('scripts/fpp-tests-a.txt', 'scripts/fpp-tests-b.txt', 'scripts/fpp-tests-c.txt');
  }
});

// 751909715: /api/scripts is alphabetical (natural, case-insensitive), not in
// directory order.
test('the script list is sorted', async ({ request }) => {
  const names = ['fpp-tests-b1.sh', 'fpp-tests-a10.sh', 'fpp-tests-A9.sh', 'fpp-tests-c.sh'];
  for (const n of names) seed(`scripts/${n}`);
  try {
    const all: string[] = await (await request.get('/api/scripts')).json();
    expect(all.filter((n) => n.startsWith('fpp-tests-')))
      .toEqual(['fpp-tests-A9.sh', 'fpp-tests-a10.sh', 'fpp-tests-b1.sh', 'fpp-tests-c.sh']);
  } finally {
    remove(...names.map((n) => `scripts/${n}`));
  }
});

// 2b4f0cc4f: /api/sequence lists sequences, not effects.
test('the sequence list holds the .fseq files and not the effects', async ({ request }) => {
  seed('sequences/fpp-tests-seq.fseq');
  seed('sequences/fpp-tests-fx.eseq');
  try {
    const names: string[] = await (await request.get('/api/sequence')).json();
    expect(names).toContain('fpp-tests-seq');
    expect(names.filter((n) => n.startsWith('fpp-tests-fx'))).toEqual([]);
  } finally {
    remove('sequences/fpp-tests-seq.fseq', 'sequences/fpp-tests-fx.eseq');
  }
});

// 37f951f24: a playlist with no description is validated like any other.
test('playlist validation copes with a playlist that has no description', async ({ request }) => {
  seed('playlists/fpp-tests-nodesc.json', '{"name":"fpp-tests-nodesc","mainPlaylist":[],"playlistInfo":{"total_duration":0,"total_items":0}}');
  try {
    const r = await request.get('/api/playlists/validate');
    const body = await r.text();
    expect(r.status()).toBe(200);
    expect(body).not.toMatch(/Warning|Undefined|Notice/);
    const rows = JSON.parse(body);
    const row = rows.find((p: any) => p.name === 'fpp-tests-nodesc');
    expect(row, body).toBeTruthy();
    expect(row.description).toBe('');
  } finally {
    remove('playlists/fpp-tests-nodesc.json');
  }
});

// 654042b53: a cape string config that is not there is a 404.
test('an unknown cape string config is a 404, a known one is served', async ({ request }) => {
  const missing = await request.get('/api/cape/strings/fpp-tests-NoSuchKey');
  expect(missing.status()).toBe(404);
  seed('tmp/strings/fpp-tests-key.json', '{"outputs":[]}');
  try {
    const found = await request.get('/api/cape/strings/fpp-tests-key');
    expect(found.status()).toBe(200);
    expect(await found.json()).toEqual({ outputs: [] });
  } finally {
    remove('tmp/strings/fpp-tests-key.json');
  }
});

// 530771242: a known output config whose file is gone is a 404.
test('an output config file that does not exist is a 404', async ({ request }) => {
  remove('config/channeloutputs.json');
  const r = await request.get('/api/channel/output/channelOutputsJSON');
  expect(r.status()).toBe(404);
});

// 9fb0681e0: a file with a non-ASCII name can be deleted.
test('a file with a non-ASCII name is deleted', async ({ request }) => {
  const name = 'fpp-tests-ünï-ファイル.txt';
  seed(`scripts/${name}`);
  try {
    const r = await request.delete(`/api/file/scripts/${encodeURIComponent(name)}`);
    expect(r.status(), await r.text()).toBe(200);
    expect(inPlayer('sh', '-c', `test -e "${MEDIA}/scripts/${name}" && echo there || echo gone`).trim()).toBe('gone');
  } finally {
    remove(`scripts/${name}`);
  }
});

// 93c8462f7: a sub-value of a JSON setting is updated in place.
test('a partial object updates the matching keys of a JSON setting', async ({ request }) => {
  const put = await request.put('/api/settings/fpptestsJson', { data: '{"a":{"x":1,"y":2},"b":3}' });
  expect(put.ok()).toBe(true);
  const upd = await request.put('/api/settings/fpptestsJson/jsonValueUpdate', { data: '{"a":{"y":9}}' });
  expect(await upd.json()).toEqual({ status: 'OK' });
  const got = await (await request.get('/api/settings/fpptestsJson')).json();
  expect(JSON.parse(got.value)).toEqual({ a: { x: 1, y: 9 }, b: 3 });
});

// 0cf286445: the file manager plays media with Range requests.
test('a media file is served in ranges for playback', async ({ request }) => {
  const bytes = Array.from({ length: 1000 }, (_, i) => i % 251);
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/music && head -c 1000 /dev/zero | tr '\\0' 'a' > ${MEDIA}/music/fpp-tests-range.mp3`);
  try {
    const part = await request.get('/api/file/Music/fpp-tests-range.mp3?play=1', { headers: { Range: 'bytes=100-199' } });
    expect(part.status()).toBe(206);
    expect(part.headers()['content-range']).toBe('bytes 100-199/1000');
    expect(part.headers()['accept-ranges']).toBe('bytes');
    expect(part.headers()['content-type']).toBe('audio/mpeg');
    expect((await part.body()).length).toBe(100);
    const past = await request.get('/api/file/Music/fpp-tests-range.mp3?play=1', { headers: { Range: 'bytes=5000-6000' } });
    expect(past.status()).toBe(416);
  } finally {
    remove('music/fpp-tests-range.mp3');
  }
  void bytes;
});

// ddbe1524d: the route used to build a URL with the command name 'Run Script' unencoded.
test('the script run route starts the script through the Run Script command', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${MEDIA}/scripts ${MEDIA}/tmp && printf '#!/bin/sh\\ntouch ${MEDIA}/tmp/fpp-tests-script-ran\\n' > "${MEDIA}/scripts/fpp-tests-run.sh" && chmod +x "${MEDIA}/scripts/fpp-tests-run.sh" && rm -f ${MEDIA}/tmp/fpp-tests-script-ran`);
  try {
    const r = await request.post('/api/scripts/' + 'fpp-tests-run.sh' + '/run');
    expect(r.ok(), await r.text()).toBe(true);
    await expect.poll(() => inPlayer('sh', '-c', `test -e ${MEDIA}/tmp/fpp-tests-script-ran && echo yes || echo no`).trim(),
      { timeout: 10000 }).toBe('yes');
  } finally {
    remove('scripts/fpp-tests-run.sh', 'tmp/fpp-tests-script-ran');
  }
});

// 5548d5b0e: the sequence API reads effects (.eseq) from the effects directory.
test('an .eseq is read from the effects directory and cannot be started as a sequence', async ({ request }) => {
  seed('effects/fpp-tests-fx.eseq', 'ESEQDATA');
  try {
    const got = await request.get('/api/sequence/fpp-tests-fx.eseq');
    expect(got.status()).toBe(200);
    expect(await got.text()).toBe('ESEQDATA');
    const start = await request.get('/api/sequence/fpp-tests-fx.eseq/start/0');
    expect(await start.text()).toMatch(/ERROR/);
  } finally {
    remove('effects/fpp-tests-fx.eseq');
  }
});

// 7246fedde: a config file can be uploaded as a multipart "file" field.
test('a config file uploaded as a multipart form is stored', async ({ request }) => {
  const body = '{"fpp":"tests-multipart"}';
  try {
    const r = await request.post('/api/configfile/fpp-tests-multipart.json', {
      multipart: { file: { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(body) } },
    });
    expect(await r.json()).toMatchObject({ Status: 'OK' });
    expect(inPlayer('cat', `${MEDIA}/config/fpp-tests-multipart.json`)).toBe(body);
  } finally {
    remove('config/fpp-tests-multipart.json');
  }
});

// f8453aba6 and 46b0281cd: a plugin can handle a file extension of its own:
// the API asks it for a file's information and re-runs its upload action.
test('a plugin handles the info and the upload action of its own file extension', async ({ request }) => {
  const dir = `${MEDIA}/plugins/fpp-tests-ext`;
  inPlayer('sh', '-c', `mkdir -p ${dir} ${MEDIA}/fpp-tests-ext-files && cat > ${dir}/pluginInfo.json <<'J'
{"fileExtensions": {".tstx": {"folder": "fpp-tests-ext-files", "infoCommand": "info.sh", "onUpload": "uploaded.sh"}}}
J
printf '#!/bin/sh\\necho "{\\\\"info\\\\": \\\\"$1\\\\"}"\\n' > ${dir}/info.sh
printf '#!/bin/sh\\necho "uploaded $1"\\n' > ${dir}/uploaded.sh
chmod +x ${dir}/info.sh ${dir}/uploaded.sh`);
  try {
    const info = await request.get('/api/file/info/fpp-tests-ext/.tstx/thing.tstx');
    expect((await info.json()).info).toMatch(/\/fpp-tests-ext-files\/thing\.tstx$/);
    const up = await request.get('/api/file/onUpload/fpp-tests-ext-files/thing.tstx');
    expect((await up.text()).trim()).toMatch(/^uploaded .*\/fpp-tests-ext-files\/thing\.tstx$/);
  } finally {
    remove('plugins/fpp-tests-ext', 'fpp-tests-ext-files');
  }
});

// 33856d7dd: the file manager creates and removes sub-directories, and
// deletes files inside them.
test('a sub-directory is created, filled, emptied and removed', async ({ request }) => {
  try {
    expect(await (await request.post('/api/dir/sequences/fpp-tests-sub')).json()).toMatchObject({ status: 'OK' });
    expect(await (await request.post('/api/dir/sequences/fpp-tests-sub')).json()).toMatchObject({ status: 'Subdirectory already exists' });
    seed('sequences/fpp-tests-sub/inner.fseq');
    expect(await (await request.delete('/api/dir/sequences/fpp-tests-sub')).json()).toMatchObject({ status: expect.stringMatching(/Unable to delete/) });
    const del = await request.delete('/api/file/sequences/fpp-tests-sub/inner.fseq');
    expect(del.status(), await del.text()).toBe(200);
    expect(await (await request.delete('/api/dir/sequences/fpp-tests-sub')).json()).toMatchObject({ status: 'OK' });
    expect(await (await request.post('/api/dir/sequences/..%2Fevil')).json()).toMatchObject({ status: expect.stringMatching(/Invalid/) });
  } finally {
    remove('sequences/fpp-tests-sub');
  }
});

// 54bb98292: a followed log runs tail under a timeout and keeps the stream
// alive with a heartbeat while the file is quiet.
test('a followed log is under a timeout and gets a heartbeat when quiet', async () => {
  test.setTimeout(90_000);
  inPlayer('sh', '-c', 'pkill -f "[t]ail -n 50 -f .*fpp-tests-follow" || true');
  seed('logs/fpp-tests-follow.log', 'first line\n');
  const http = await import('http');
  try {
    const base = new URL(process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080');
    const got = await new Promise<string>((resolve, reject) => {
      let body = '';
      const req = http.request({ host: base.hostname, port: base.port || 80, path: '/api/file/Logs/tailfollow/fpp-tests-follow.log' }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
      });
      req.on('error', reject);
      req.end();
      setTimeout(() => {
        // the process tail runs as, while the request is still open
        body += '\nPS:' + inPlayer('sh', '-c', 'ps -eo args | grep "tail -n" | grep -v grep || true');
        req.destroy();
        resolve(body);
      }, 35_000);
    });
    expect(got).toContain('first line');
    expect(got).toMatch(/PS:.*timeout 300 tail -n 50 -f .*fpp-tests-follow\.log/s);
    expect(got).toContain(': heartbeat');
  } finally {
    inPlayer('sh', '-c', 'pkill -f "[t]ail -n 50 -f .*fpp-tests-follow" || true');
    remove('logs/fpp-tests-follow.log');
  }
});
