import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { BACKUPS, putFile } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// How the JSON backups list reads each backup file for its comment: one file
// at a time, surviving one that isn't JSON, and with the backup drive mounted
// while it reads the drive's backups.  GET /api/backups/configuration/list is
// what the Backups page lists, and what every settings-change backup prunes
// through.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// Unique per run: the listing caches each file's comment by path, size and mtime.
const RUN = Date.now();

async function list(request: APIRequestContext) {
  const r = await request.get('/api/backups/configuration/list');
  const body = await r.text();
  expect(r.status(), body.slice(0, 2000)).toBe(200);
  // A PHP fatal still answers 200 here, with the error as HTML.
  try {
    return JSON.parse(body) as Array<Record<string, any>>;
  } catch {
    throw new Error(`the listing is not JSON: ${body.replace(/<[^>]+>/g, '').slice(0, 600)}`);
  }
}

function backupJson(comment: string, extra: object = {}) {
  return JSON.stringify({
    fpp_backup_version: '8.0', backup_comment: comment, backup_trigger_source: 'fpp-tests',
    backup_taken: Math.floor(RUN / 1000), ...extra,
  });
}

// Regression: 3dff1656c ("Check JSON backup data is valid before
// referencing", #2174).  A backup file that doesn't decode (cut short by a
// full disk or a pulled plug) gave json_decode() null, and
// array_key_exists('backup_comment', null) is a TypeError in PHP 8: the whole
// listing answered 500, so the Backups page showed none of the good backups.
test('a backup file that is not valid JSON does not take the listing down', async ({ request }) => {
  const good = `fpp-tests-good_${RUN}.json`;
  const bad = `fpp-tests-truncated_${RUN}.json`;
  putFile(`${BACKUPS}/${good}`, backupJson('fpp-tests good backup'));
  putFile(`${BACKUPS}/${bad}`, backupJson('fpp-tests cut short').slice(0, 40));
  try {
    const rows = await list(request);
    const g = rows.find((b) => b.backup_filename === good);
    expect(g, 'the good backup is not listed').toBeTruthy();
    expect(g!.backup_comment).toBe('fpp-tests good backup');
    const b = rows.find((r) => r.backup_filename === bad);
    expect(b, 'the damaged backup is not listed').toBeTruthy();
    expect(b!.backup_comment).toBe('');
  } finally {
    inPlayer('rm', '-f', `${BACKUPS}/${good}`, `${BACKUPS}/${bad}`);
  }
});

// Regression: 64004c1a4 ("Individually read contents of each backup file",
// #2118).  The listing asked read_directory_files() for every backup's
// contents at once, so a player with a few large backups (a big
// channel-output or pixel-overlay config in each) went over PHP's 128 MB
// memory_limit and the listing died with "Allowed memory size exhausted".
// Eight 20 MB backups are 160 MB together; one at a time, each fits.
test('large backups are listed one at a time, within PHP memory', async ({ request }) => {
  test.setTimeout(180_000);
  const names = Array.from({ length: 8 }, (_, i) => `fpp-tests-large-${i}_${RUN}.json`);
  const pad = 'x'.repeat(20 * 1024 * 1024);
  try {
    for (const [i, n] of names.entries()) {
      putFile(`${BACKUPS}/${n}`, backupJson(`fpp-tests large ${i}`, { fpp_tests_padding: pad }));
    }
    const rows = await list(request);
    for (const [i, n] of names.entries()) {
      expect(rows.find((b) => b.backup_filename === n)?.backup_comment, n).toBe(`fpp-tests large ${i}`);
    }
  } finally {
    inPlayer('sh', '-c', `rm -f ${names.map((n) => `${BACKUPS}/${n}`).join(' ')}`);
  }
});

// A drive for jsonConfigBackupUSBLocation.  The player can't mount (no
// CAP_SYS_ADMIN), so mount and umount are stand-ins in /usr/local/bin (which
// PHP's shell and sudo's secure_path find first): mounting the fake device on
// /mnt/tmp puts the drive's files there, and unmounting takes them away again,
// so a file is only readable while the drive is mounted, as on a player.
// Anything else goes to the real tool.
const MARK = 'fpp-tests-backup-drive-stub';
const DRIVE = '/tmp/fpp-tests-backup-drive';
const DEV = 'sdz9';
const STUBS: Record<string, string> = {
  mount: `
for a in "$@"; do mp="$a"; done
case " $* " in *" /dev/${DEV} /mnt/tmp "*) mkdir -p /mnt/tmp && cp -a ${DRIVE}/. /mnt/tmp/; exit 0 ;; esac
exec /usr/bin/mount "$@"`,
  umount: `
for a in "$@"; do mp="$a"; done
if [ "$mp" = /mnt/tmp ]; then find /mnt/tmp -mindepth 1 -delete 2>/dev/null; exit 0; fi
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
    `grep -q ${MARK} $f 2>/dev/null && rm -f $f; done; rm -rf ${DRIVE}; ` +
    `[ -d /mnt/tmp ] && find /mnt/tmp -mindepth 1 -delete 2>/dev/null; true`);
}

// Regression: 37e8dac8b ("Fix reading backups from alternative location",
// #2174).  After 64004c1a4 each backup is opened to read its comment, but the
// backups on the backup drive were opened after DriveMountHelper() had
// unmounted it again: every one was listed with no comment (and an "Unable to
// decode JSON backup file" error logged for each).
test("backups on the backup drive are listed with their comments", async ({ request }) => {
  const name = `fpp-tests-on-drive_${RUN}.json`;
  try {
    await keepingSettings(async () => {
      standInDrive();
      inPlayer('sh', '-c', `mkdir -p ${DRIVE}/Automatic_Backups/config/backups`);
      putFile(`${DRIVE}/Automatic_Backups/config/backups/${name}`, backupJson('fpp-tests on the drive'));
      setSettingInFile('jsonConfigBackupUSBLocation', DEV);

      const row = (await list(request)).find((b) => b.backup_filename === name);
      expect(row, 'the backup on the drive is not listed').toBeTruthy();
      expect(row!.backup_alternative_location).toBe(true);
      expect(row!.backup_comment, 'the backup on the drive was read after the drive was unmounted').toBe('fpp-tests on the drive');
      // The drive is not left mounted.
      expect(inPlayer('sh', '-c', 'ls -A /mnt/tmp 2>/dev/null || true').trim()).toBe('');
    });
  } finally {
    removeDrive();
  }
});
