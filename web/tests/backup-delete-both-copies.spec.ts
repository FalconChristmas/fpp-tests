import { test, expect } from './fixtures';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { BACKUPS, exists, putFile } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Deleting a backup that is on the backup drive also deletes the copy kept on
// the player's own storage, so the next copy to the drive doesn't bring it
// back.  Feature: 89f4556a4 ("Delete Backups from SD and USB and use
// GetDirSetting() for filepaths").  The drive is a stand-in mount: mounting
// /dev/sdz9 on /mnt/tmp copies the drive's files there, and unmounting writes
// /mnt/tmp back to the drive, so a delete is seen on the drive afterwards.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-delete-drive-stub';
const DRIVE = '/tmp/fpp-tests-delete-drive';
const DEV = 'sdz9';
const NAME = 'fpp-tests-both-copies_2026-10-01_00-00-00.json';
const ON_DRIVE = `${DRIVE}/Automatic_Backups/config/backups/${NAME}`;
const STUBS: Record<string, string> = {
  mount: `
case " $* " in *" /dev/${DEV} /mnt/tmp "*) mkdir -p /mnt/tmp && cp -a ${DRIVE}/. /mnt/tmp/ && touch /mnt/tmp/.fpp-tests-mounted; exit 0 ;; esac
exec /usr/bin/mount "$@"`,
  umount: `
for a in "$@"; do mp="$a"; done
if [ "$mp" = /mnt/tmp ]; then if [ -e /mnt/tmp/.fpp-tests-mounted ]; then rm -f /mnt/tmp/.fpp-tests-mounted; rm -rf ${DRIVE}.new && mkdir -p ${DRIVE}.new && cp -a /mnt/tmp/. ${DRIVE}.new/ && rm -rf ${DRIVE} && mv ${DRIVE}.new ${DRIVE}; fi; find /mnt/tmp -mindepth 1 -delete 2>/dev/null; exit 0; fi
exec /usr/bin/umount "$@"`,
};

function standInDrive() {
  for (const [tool, body] of Object.entries(STUBS)) {
    const path = `/usr/local/bin/${tool}`;
    const real = inPlayer('sh', '-c', `test -e ${path} && ! grep -q ${MARK} ${path} && echo real || true`).trim();
    if (real === 'real') throw new Error(`${path} is a real program in the player; not replacing it`);
    execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${path} && chmod 755 ${path}`],
      { input: `#!/bin/sh\n# ${MARK}\n${body.trim()}\n` });
  }
}

function removeDrive() {
  inPlayer('sh', '-c', `for t in ${Object.keys(STUBS).join(' ')}; do f=/usr/local/bin/$t; ` +
    `grep -q ${MARK} $f 2>/dev/null && rm -f $f; done; rm -rf ${DRIVE} ${DRIVE}.new; ` +
    `[ -d /mnt/tmp ] && find /mnt/tmp -mindepth 1 -delete 2>/dev/null; true`);
}

test('deleting a backup from the backup drive deletes the copy on the player too', async ({ request }) => {
  const json = JSON.stringify({ fpp_backup_version: '8.0', backup_comment: 'fpp-tests both copies', backup_taken: 1790000000 });
  try {
    await keepingSettings(async () => {
      standInDrive();
      inPlayer('sh', '-c', `mkdir -p ${DRIVE}/Automatic_Backups/config/backups ${BACKUPS}`);
      putFile(ON_DRIVE, json);
      putFile(`${BACKUPS}/${NAME}`, json);
      setSettingInFile('jsonConfigBackupUSBLocation', DEV);

      const del = await (await request.delete(`/api/backups/configuration/JsonBackupsAlternate/${NAME}`)).json();
      expect(del.Status, JSON.stringify(del)).toBe('OK');
      // The copy on the drive is gone (the drive was written back on unmount).
      expect(exists(ON_DRIVE), 'the copy on the drive is still there').toBe(false);
      expect(exists(`${BACKUPS}/${NAME}`), "the player's own copy is still there").toBe(false);
    });
  } finally {
    removeDrive();
    inPlayer('rm', '-f', `${BACKUPS}/${NAME}`);
  }
});
