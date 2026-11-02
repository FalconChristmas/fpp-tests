import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, putFile, snapshotSettings } from './settings-file';

// A JSON backup records the version of the backup file format it was written
// in (fpp_backup_version), which a restore reads to decide how much old data
// needs massaging.

test.skip(!container, 'needs the player container that run-web.sh serves');

test('a backup is written with the backup format version', async ({ request }) => {
  // Regression: 39779ced0.  The variable holding the format version was
  // renamed in one place and not the other, so the file was written with
  // "fpp_backup_version": null and every restore guessed.
  const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests format version' })).json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  const path = String(made.backup_file_path);
  try {
    const written = JSON.parse(inPlayer('cat', path));
    expect(written.fpp_backup_version, JSON.stringify(Object.keys(written))).toMatch(/^\d+\.\d+$/);
    // The receiving end: the restore of that very file accepts it.
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${path.split('/').pop()}`, { data: 'settings' });
    expect((await r.json()).Success, 'the restore did not run').toBe(true);
  } finally {
    inPlayer('rm', '-f', path);
    await request.put('/api/settings/rebootFlag', { data: '0' });
    inPlayer('rm', '-f', '/fpp_restored');
  }
});

test('a backup whose format version is null still restores', async ({ request }) => {
  // The other half of 39779ced0's version handling: a file with a null version
  // takes the current format's, and the restore still runs.  (Not red on its
  // own revert: the control that the null is read at all.)
  const name = 'fpp-tests-null-version_20260101000000.json';
  putFile(`${BACKUPS}/${name}`, JSON.stringify({
    fpp_backup_version: null, backup_comment: 'fpp-tests null version', channelOutputs: { universes: { universes: [{ active: 0 }] } },
  }));
  const restoreSettings = snapshotSettings();
  try {
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${name}`, { data: 'channelOutputs' });
    expect(r.status()).toBe(200);
    expect(await r.json()).toMatchObject({ Success: true });
  } finally {
    restoreSettings();
    inPlayer('rm', '-f', `${BACKUPS}/${name}`, '/fpp_restored');
  }
});
