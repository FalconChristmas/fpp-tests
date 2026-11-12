import { createHash } from 'crypto';
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { BACKUPS, exists, putFile } from './settings-file';

// A large area of a configuration backup is stored once, in
// config/backups/blobs/<sha256>.json, and every backup with that content
// refers to it (backup-listing.spec.ts).  File Manager's Config tab lists that
// folder, so its Delete button reaches the blobs: DELETE /api/file/config/...
// refuses one that a backup still refers to, and says which backups would be
// lost (www/common.php DescribeBackupBlobDeletion, GetBackupBlobReferenceMap).

test.skip(!container, 'seeds backups and blobs inside the run-web.sh container');

const BLOBS = `${BACKUPS}/blobs`;
const blob = JSON.stringify(Array.from({ length: 50 }, (_, i) => `fpp-tests blob guard line ${i}`));
const HASH = createHash('sha256').update(blob).digest('hex');
const ORPHAN_BODY = JSON.stringify(['fpp-tests blob guard: nothing refers to this']);
const ORPHAN = createHash('sha256').update(ORPHAN_BODY).digest('hex');
const backupName = (n: number) => `fpp-tests-blobguard-${n}.json`;
const backup = (n: number) => JSON.stringify({
  backup_comment: `fpp-tests blob guard ${n}`,
  virtualdisplaymap: { __fppBlob: { sha256: HASH, size: blob.length } },
});

let madeBlobDir = false;
function clean() {
  inPlayer('sh', '-c', `rm -f -- "${BACKUPS}"/fpp-tests-blobguard-* "${BLOBS}/${HASH}.json" "${BLOBS}/${ORPHAN}.json" "${BLOBS}/fpp-tests-blobguard.txt"`);
}
test.beforeEach(() => {
  clean();
  madeBlobDir = !exists(BLOBS);
  inPlayer('mkdir', '-p', BLOBS);
  putFile(`${BLOBS}/${HASH}.json`, blob);
});
test.afterEach(() => {
  clean();
  // Only a folder this test made, and only if nothing else has used it since.
  if (madeBlobDir) inPlayer('sh', '-c', `rmdir "${BLOBS}" 2>/dev/null || true`);
});

const del = async (request: APIRequestContext, path: string) => {
  const r = await request.delete(`/api/file/config/backups/${path}`);
  return { code: r.status(), ...(await r.json()) } as { code: number; status: string };
};

test('a blob two backups share is not deleted, and both are named', async ({ request }) => {
  putFile(`${BACKUPS}/${backupName(1)}`, backup(1));
  putFile(`${BACKUPS}/${backupName(2)}`, backup(2));
  const r = await del(request, `blobs/${HASH}.json`);
  expect(r.status).toBe(
    'Refusing to delete - this is not a file of its own - it is configuration that ' +
    `${backupName(1)}, ${backupName(2)} share a single copy of. Deleting it leaves those backups unrestorable. ` +
    'To reclaim the space, delete the backups themselves and this is removed automatically.');
  expect(exists(`${BLOBS}/${HASH}.json`), 'the blob').toBe(true);

  // And it still does its job: the backup downloads whole.
  const whole = await request.get(`/api/backups/configuration/JsonBackups/${backupName(1)}`);
  expect(whole.status()).toBe(200);
  expect(JSON.stringify(JSON.parse(await whole.text()).virtualdisplaymap)).toBe(blob);
});

test('the refusal counts the backups: one is "that backup", past three the rest are a number', async ({ request }) => {
  putFile(`${BACKUPS}/${backupName(1)}`, backup(1));
  let r = await del(request, `blobs/${HASH}.json`);
  expect(r.status).toContain(`configuration that ${backupName(1)} share a single copy of. Deleting it leaves that backup unrestorable.`);

  for (const n of [2, 3, 4, 5]) putFile(`${BACKUPS}/${backupName(n)}`, backup(n));
  r = await del(request, `blobs/${HASH}.json`);
  expect(r.status).toContain(`${backupName(1)}, ${backupName(2)}, ${backupName(3)} and 2 other backups share a single copy of`);
  expect(exists(`${BLOBS}/${HASH}.json`)).toBe(true);
});

test('the blobs folder is not emptied while a backup refers into it', async ({ request }) => {
  putFile(`${BACKUPS}/${backupName(1)}`, backup(1));
  putFile(`${BACKUPS}/${backupName(2)}`, backup(2));
  const r = await del(request, 'blobs');
  expect(r.status).toMatch(/^Refusing to delete - this folder holds configuration shared by \d+ backups rather than files of its own, and emptying it leaves all of them unrestorable\./);
  expect(exists(`${BLOBS}/${HASH}.json`)).toBe(true);
});

test('once its backups are gone a blob can be deleted, and so can a file that is no blob', async ({ request }) => {
  // The backup that referred to it was just removed: the answer follows the
  // files, not a remembered list.
  putFile(`${BACKUPS}/${backupName(1)}`, backup(1));
  expect((await del(request, `blobs/${HASH}.json`)).status).toContain('Refusing to delete');
  inPlayer('rm', '-f', `${BACKUPS}/${backupName(1)}`);
  expect((await del(request, `blobs/${HASH}.json`)).status).toBe('OK');
  expect(exists(`${BLOBS}/${HASH}.json`)).toBe(false);

  putFile(`${BLOBS}/${ORPHAN}.json`, ORPHAN_BODY);
  putFile(`${BLOBS}/fpp-tests-blobguard.txt`, 'notes');
  // A backup that refers to another blob does not protect this one.
  putFile(`${BACKUPS}/${backupName(2)}`, backup(2));
  expect((await del(request, `blobs/${ORPHAN}.json`)).status).toBe('OK');
  expect((await del(request, 'blobs/fpp-tests-blobguard.txt')).status).toBe('OK');
  expect(exists(`${BLOBS}/${ORPHAN}.json`)).toBe(false);
  expect(exists(`${BLOBS}/fpp-tests-blobguard.txt`)).toBe(false);
});

test('a backup rewritten to refer to the blob protects it at once', async ({ request }) => {
  // The reference map answers from the listing's metadata cache when a
  // backup's size and time still match: a backup changed since must be read
  // again.
  const plain = JSON.stringify({ backup_comment: 'fpp-tests blob guard, no blob', virtualdisplaymap: ['inline'] });
  putFile(`${BACKUPS}/${backupName(1)}`, plain);
  // The listing fills the cache.
  expect((await request.get('/api/backups/configuration/list')).status()).toBe(200);
  await new Promise((res) => setTimeout(res, 1100));
  putFile(`${BACKUPS}/${backupName(1)}`, backup(1));
  expect((await del(request, `blobs/${HASH}.json`)).status).toContain('Refusing to delete');
  expect(exists(`${BLOBS}/${HASH}.json`)).toBe(true);
});
