import { test, expect } from './fixtures';
import { container, inPlayer } from './container';

// /api/configfile for a file in a folder of its own: an upload makes the
// folders it names, a delete removes one file, and neither follows a link (or
// a name) out of the config directory.  configfile-dotdot.spec.ts covers
// "../" in the name, path-containment.spec.ts a link to a sibling directory.

test.skip(!container, 'puts files and links in the config directory of the player run-web.sh serves');

const CONFIG = '/home/fpp/media/config';
const DIR = 'fpp-tests-configfile';
const OUTSIDE = '/tmp/fpp-tests-configfile-outside';
const BACKUPS = `${CONFIG}/backups`;

const has = (path: string) => inPlayer('sh', '-c', `test -e '${path}' && echo y || echo n`).trim() === 'y';

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${CONFIG}/${DIR} ${OUTSIDE}; mkdir -p ${OUTSIDE} ${BACKUPS}; ls ${BACKUPS} > /tmp/fpp-tests-configfile.backups; ` +
    `echo precious > ${OUTSIDE}/keep.txt`);
});
test.afterEach(() => {
  // An upload leaves a config backup behind.
  inPlayer('sh', '-c', `rm -rf ${CONFIG}/${DIR} ${OUTSIDE}; cd ${BACKUPS} && ls | grep -vxF -f /tmp/fpp-tests-configfile.backups | xargs -r rm -f; ` +
    'rm -f /tmp/fpp-tests-configfile.backups');
});

test('an upload to folders that are not there makes them, and the file is listed and served from there', async ({ request }) => {
  const name = `${DIR}/a/b/deep.json`;
  const up = await request.post(`/api/configfile/${name}`, { data: '{"deep": true}', headers: { 'Content-Type': 'text/html' } });
  expect(up.status(), await up.text()).toBe(200);
  expect(await up.json()).toEqual({ Status: 'OK', Message: '' });
  expect(inPlayer('cat', `${CONFIG}/${name}`)).toBe('{"deep": true}');

  const got = await request.get(`/api/configfile/${name}`);
  expect(got.status()).toBe(200);
  expect(await got.text()).toBe('{"deep": true}');
  // A folder's name lists what is under it, by path from it.
  const list = await (await request.get(`/api/configfile/${DIR}`)).json();
  expect(list).toEqual({ Path: DIR, ConfigFiles: ['a/b/deep.json'] });
  expect((await (await request.get('/api/configfile')).json()).ConfigFiles).toContain(name);
});

test('a delete removes the one file, and says so when there is no such file', async ({ request }) => {
  inPlayer('sh', '-c', `mkdir -p ${CONFIG}/${DIR}/sub && echo 1 > ${CONFIG}/${DIR}/one.json && echo 2 > ${CONFIG}/${DIR}/sub/two.json`);
  const del = await request.delete(`/api/configfile/${DIR}/sub/two.json`);
  expect(del.status(), await del.text()).toBe(200);
  expect(await del.json()).toEqual({ Status: 'OK', Message: '' });
  expect(has(`${CONFIG}/${DIR}/sub/two.json`)).toBe(false);
  expect(has(`${CONFIG}/${DIR}/one.json`)).toBe(true);

  // Again, a file that never was, and a folder: none is a regular file.
  for (const name of [`${DIR}/sub/two.json`, `${DIR}/never.json`, `${DIR}/sub`]) {
    const r = await request.delete(`/api/configfile/${name}`);
    expect(await r.json(), name).toEqual({ Status: 'Error', Message: `${name} is not a regular file` });
  }
  expect(has(`${CONFIG}/${DIR}/sub`)).toBe(true);
  expect(has(`${CONFIG}/${DIR}/one.json`)).toBe(true);
});

test.describe('a link in the config directory that leads out of it', () => {
  test.beforeEach(() => {
    inPlayer('sh', '-c', `mkdir -p ${CONFIG}/${DIR} && ln -s ${OUTSIDE} ${CONFIG}/${DIR}/out && ln -s ${OUTSIDE}/keep.txt ${CONFIG}/${DIR}/keep-link.txt`);
  });
  const refused = async (r: import('@playwright/test').APIResponse, what: string) => {
    expect(r.status(), `${what}: ${await r.text()}`).toBe(403);
    expect((await r.json()).Status).toBe('Error');
  };

  test('is not deleted through', async ({ request }) => {
    await refused(await request.delete(`/api/configfile/${DIR}/out/keep.txt`), 'a file under a linked folder');
    await refused(await request.delete(`/api/configfile/${DIR}/keep-link.txt`), 'a linked file');
    expect(inPlayer('cat', `${OUTSIDE}/keep.txt`)).toBe('precious\n');
    // The link itself is still there too.
    expect(inPlayer('readlink', `${CONFIG}/${DIR}/keep-link.txt`).trim()).toBe(`${OUTSIDE}/keep.txt`);
  });

  test('is not read or written through, into a folder that is there or one that would be made', async ({ request }) => {
    await refused(await request.get(`/api/configfile/${DIR}/out/keep.txt`), 'reading under a linked folder');
    await refused(await request.post(`/api/configfile/${DIR}/out/keep.txt`, { data: 'replaced' }), 'replacing a file under a linked folder');
    await refused(await request.post(`/api/configfile/${DIR}/out/new.txt`, { data: 'new' }), 'a new file in a linked folder');
    // Folders that do not exist yet, under the link: nothing is made outside.
    await refused(await request.post(`/api/configfile/${DIR}/out/made/deeper/new.txt`, { data: 'new' }), 'new folders under a linked folder');
    expect(inPlayer('ls', OUTSIDE).trim()).toBe('keep.txt');
    expect(inPlayer('cat', `${OUTSIDE}/keep.txt`)).toBe('precious\n');
  });

  test('beside real folders: the control', async ({ request }) => {
    const up = await request.post(`/api/configfile/${DIR}/real/made/new.txt`, { data: 'new' });
    expect(up.status(), await up.text()).toBe(200);
    expect(inPlayer('cat', `${CONFIG}/${DIR}/real/made/new.txt`)).toBe('new');
  });
});

test('the credential files are refused for a delete as for a read, and stay', async ({ request }) => {
  const htpasswd = `${CONFIG}/.htpasswd`;
  const had = has(htpasswd);
  if (!had) inPlayer('sh', '-c', `echo 'fpp-tests:x' > ${htpasswd}`);
  try {
    const r = await request.delete('/api/configfile/.htpasswd');
    expect(r.status(), await r.text()).toBe(403);
    expect(has(htpasswd)).toBe(true);
    expect((await request.get('/api/configfile/.htpasswd')).status()).toBe(403);
  } finally {
    if (!had) inPlayer('rm', '-f', htpasswd);
  }
});
