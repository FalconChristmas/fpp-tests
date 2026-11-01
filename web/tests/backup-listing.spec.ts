import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, exists, putFile, readFile } from './settings-file';

// What the configuration backups list, carry and store.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function list(request: APIRequestContext) {
  const r = await request.get('/api/backups/configuration/list');
  const body = await r.text();
  expect(r.status(), body).toBe(200);
  return JSON.parse(body) as Array<Record<string, any>>;
}

async function makeBackup(request: APIRequestContext, comment: string) {
  const made = await (await request.post('/api/backups/configuration', { data: comment })).json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  return String(made.backup_file_path).split('/').pop()!;
}

// Regression: 554cfd8f2. The listing took each backup's date from the
// timestamp in its name; a .json with none (copied in by hand, or renamed) made
// createFromFormat() return false, and ->format() on false is a fatal that
// took out the whole listing, the Backups page with it, and every
// settings-change backup, which prune through the same code.
test('a backup with no timestamp in its name is listed, dated by its mtime', async ({ request }) => {
  const file = `${BACKUPS}/fpp-tests-handmade.json`;
  putFile(file, JSON.stringify({ backup_comment: 'fpp-tests handmade', settings: {} }));
  inPlayer('touch', '-d', '2026-01-02 03:04:05', file);
  try {
    const row = (await list(request)).find((b) => b.backup_filename === 'fpp-tests-handmade.json');
    expect(row, 'the hand-made backup is not listed').toBeTruthy();
    expect(row!.backup_comment).toBe('fpp-tests handmade');
    expect(Number(row!.backup_time_unix)).toBe(Number(inPlayer('stat', '-c', '%Y', file).trim()));
  } finally {
    inPlayer('rm', '-f', file);
  }
});

// Regression: 861315534. Extra config files are swept into a backup by name;
// the test was "contains .json", so every sidecar copy beside a config file
// (co-other.json.backup, gpio.json.conflict) was backed up as config as well.
// Also 3b20ec1ff: any other JSON file in the config folder is backed up (the
// control below), where only known areas' files were.
// Also 271b6525b: backup.php, included by the backups API, prints none of its
// page (it used to put the whole HTML page ahead of the JSON), so this call
// and the large-area one below parse as JSON.
test('a sidecar copy of a config file is not backed up as config', async ({ request }) => {
  const extra = `${MEDIA}/config/fpp-tests-extra.json`;
  const sidecar = `${MEDIA}/config/fpp-tests-extra.json.backup`;
  putFile(extra, '{"fpp-tests": 1}');
  putFile(sidecar, '{"fpp-tests": 2}');
  let file = '';
  try {
    file = await makeBackup(request, 'fpp-tests sidecar');
    const configs = JSON.parse(readFile(`${BACKUPS}/${file}`)).misc_configs.configs[0];
    // The control: a real extra config file is carried.
    expect(Object.keys(configs)).toContain('fpp-tests-extra.json');
    expect(Object.keys(configs), 'the sidecar copy was backed up').not.toContain('fpp-tests-extra.json.backup');
  } finally {
    inPlayer('rm', '-f', extra, sidecar);
    if (file) await request.delete(`/api/backups/configuration/JsonBackups/${file}`);
  }
});

// Regression: 625978927. The full-backup folders on a backup drive were listed
// minus every name that also existed in the media directory, so one stray
// folder there (which restoring a drive's root creates) hid the backup folder
// of the same name for good.  Also 9a001e343: GET /api/backups/list reads the
// backups folder under the media directory at all.
test("a stray media folder does not hide the backup folder of that name", async ({ request }) => {
  const name = 'FppTestsShow';
  inPlayer('mkdir', '-p', `${MEDIA}/backups/${name}/config`, `${MEDIA}/${name}`);
  putFile(`${MEDIA}/backups/${name}/fpp-tests-notes.txt`, 'x');
  try {
    const r = await request.get('/api/backups/list');
    expect(r.status()).toBe(200);
    const dirs = await r.json();
    expect(dirs).toContain('/');
    expect(dirs, 'the backup folder was hidden by the media folder of the same name').toContain(name);
    // Media subfolders inside it are still not offered as backups.
    expect(dirs).not.toContain(`${name}/config`);
    // Also c200f4a36: only folders are offered, not a file inside a backup folder.
    expect(dirs).not.toContain(`${name}/fpp-tests-notes.txt`);
  } finally {
    inPlayer('rm', '-rf', `${MEDIA}/backups/${name}`, `${MEDIA}/${name}`);
  }
});

// Feature: ffd9d0b43. A large area is stored once, in backups/blobs under the
// hash of its contents, and every backup holding the same content refers to
// it; downloading or restoring a backup puts the content back.
test('an unchanged large area is stored once and restores intact', async ({ request }) => {
  const map = `${MEDIA}/config/virtualdisplaymap`;
  const lines = Array.from({ length: 8000 }, (_, i) => `${i},0,0,0,fpp-tests display map line ${'x'.repeat(16)}`);
  const content = lines.join('\n') + '\n';
  const hadMap = exists(map);
  const original = hadMap ? readFile(map) : '';
  putFile(map, content);
  const files: string[] = [];
  let hash = '';
  try {
    files.push(await makeBackup(request, 'fpp-tests blob 1'));
    // Backup names are to the second.
    await new Promise((r) => setTimeout(r, 1100));
    files.push(await makeBackup(request, 'fpp-tests blob 2'));
    const refs = files.map((f) => JSON.parse(readFile(`${BACKUPS}/${f}`)).virtualdisplaymap);
    for (const ref of refs) {
      expect(ref, 'the large area was stored inline').toHaveProperty('__fppBlob.sha256');
    }
    hash = refs[0].__fppBlob.sha256;
    expect(refs[1].__fppBlob.sha256).toBe(hash);
    expect(exists(`${BACKUPS}/blobs/${hash}.json`)).toBe(true);
    expect(Number(inPlayer('stat', '-c', '%s', `${BACKUPS}/${files[1]}`).trim())).toBeLessThan(content.length / 10);

    // Downloaded, the backup stands on its own.
    const dl = await request.get(`/api/backups/configuration/JsonBackups/${files[1]}`);
    expect(dl.status()).toBe(200);
    const whole = JSON.parse(await dl.text());
    expect(whole.virtualdisplaymap.join('\n').trimEnd()).toBe(content.trimEnd());

    // Restored, the file comes back as it was.
    putFile(map, 'fpp-tests replaced\n');
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${files[1]}`, { data: 'virtualdisplaymap' });
    expect((await r.json()).Success).toBe(true);
    expect(readFile(map).trimEnd()).toBe(content.trimEnd());
  } finally {
    if (hadMap) putFile(map, original); else inPlayer('rm', '-f', map);
    for (const f of files) await request.delete(`/api/backups/configuration/JsonBackups/${f}`);
    if (hash) inPlayer('rm', '-f', `${BACKUPS}/blobs/${hash}.json`);
    inPlayer('rm', '-f', '/fpp_restored');
    await request.put('/api/settings/rebootFlag', { data: '0' });
  }
});

// Feature: d3e2de6cb. A setting change answers without waiting for its backup,
// which is made by a detached request; the listing reads each backup's comment
// from a cache keyed on size and mtime, so a rewritten backup is read again.
// Also 16ba48687: a setting change takes a backup at all (others are
// backup-triggers.spec.ts).
test("a setting change's backup appears, and a rewritten backup's comment is read again", async ({ request }) => {
  const value = `fpp-tests-${Date.now()}`;
  const saved = await request.put('/api/settings/HostDescription', { data: value });
  expect(saved.ok()).toBe(true);
  let row: Record<string, any> | undefined;
  await expect.poll(async () => {
    row = (await list(request)).find((b) => String(b.backup_comment).includes(value));
    return !!row;
  }, { timeout: 30_000, message: "the setting change's backup never appeared" }).toBe(true);
  const path = `${row!.backup_filedirectory}/${row!.backup_filename}`;
  try {
    const backup = JSON.parse(readFile(path));
    backup.backup_comment = 'fpp-tests rewritten comment, a different length';
    putFile(path, JSON.stringify(backup));
    const again = (await list(request)).find((b) => b.backup_filename === row!.backup_filename);
    expect(again?.backup_comment, 'the listing served the cached comment of a rewritten backup').toBe(backup.backup_comment);
  } finally {
    await request.delete(`/api/backups/configuration/JsonBackups/${row!.backup_filename}`);
    await request.put('/api/settings/HostDescription?skipBackup=1', { data: '' });
  }
});
