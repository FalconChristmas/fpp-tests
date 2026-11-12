import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';
import { BACKUPS, SETTINGS, putFile, readFile } from './settings-file';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// A settings backup downloaded from, and restored from, the backup drive
// through the API (/api/backups/configuration/JsonBackupsAlternate/...), and
// what the two answer when there is nothing to give.  The drive is the
// stand-in mount of backup-delete-both-copies.spec.ts: mounting /dev/sdz7 on
// /mnt/tmp copies the drive's files there.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MARK = 'fpp-tests-api-drive-stub';
const DRIVE = '/tmp/fpp-tests-api-drive';
const DEV = 'sdz7';
const NAME = 'fpp-tests-api-drive_2026-10-01_00-00-00.json';
const ON_DRIVE = `${DRIVE}/Automatic_Backups/config/backups/${NAME}`;
const API = '/api/backups/configuration';
const STUBS: Record<string, string> = {
  mount: `
case " $* " in *" /dev/${DEV} /mnt/tmp "*) mkdir -p /mnt/tmp && cp -a ${DRIVE}/. /mnt/tmp/ && touch /mnt/tmp/.fpp-tests-mounted; echo mounted >> ${DRIVE}.log; exit 0 ;; esac
exec /usr/bin/mount "$@"`,
  umount: `
for a in "$@"; do mp="$a"; done
if [ "$mp" = /mnt/tmp ]; then find /mnt/tmp -mindepth 1 -delete 2>/dev/null; exit 0; fi
exec /usr/bin/umount "$@"`,
};

const BACKUP = {
  fpp_backup_version: '8.0', backup_comment: 'fpp-tests on the drive', backup_taken: 1790000000,
  settings: { system_settings: [{ HostDescription: 'fpp-tests-from-the-drive' }] },
};

function standInDrive() {
  for (const [tool, body] of Object.entries(STUBS)) {
    const path = `/usr/local/bin/${tool}`;
    const real = inPlayer('sh', '-c', `test -e ${path} && ! grep -q ${MARK} ${path} && echo real || true`).trim();
    if (real === 'real') throw new Error(`${path} is a real program in the player; not replacing it`);
    execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > ${path} && chmod 755 ${path}`],
      { input: `#!/bin/sh\n# ${MARK}\n${body.trim()}\n` });
  }
  inPlayer('sh', '-c', `mkdir -p ${DRIVE}/Automatic_Backups/config/backups ${BACKUPS}`);
  putFile(ON_DRIVE, JSON.stringify(BACKUP));
}
const mountCount = () => inPlayer('sh', '-c', `cat ${DRIVE}.log 2>/dev/null || true`).split('\n').filter(Boolean).length;

test.afterEach(() => {
  inPlayer('sh', '-c', `for t in ${Object.keys(STUBS).join(' ')}; do f=/usr/local/bin/$t; ` +
    `grep -q ${MARK} $f 2>/dev/null && rm -f $f; done; rm -rf ${DRIVE} ${DRIVE}.log ${BACKUPS}/fpp-tests-api-drive* /fpp_restored; ` +
    `[ -d /mnt/tmp ] && find /mnt/tmp -mindepth 1 -delete 2>/dev/null; true`);
});

const description = () => readFile(SETTINGS).split('\n').find((l) => l.startsWith('HostDescription = '));
const restore = async (request: APIRequestContext, dir: string, name: string, area: string) =>
  (await request.post(`${API}/restore/${dir}/${name}`, { data: area, headers: { 'Content-Type': 'text/plain' } })).json();

test('a backup on the drive is downloaded whole, as a file of its own name', async ({ request }) => {
  await keepingSettings(async () => {
    standInDrive();
    setSettingInFile('jsonConfigBackupUSBLocation', DEV);
    const r = await request.get(`${API}/JsonBackupsAlternate/${NAME}`);
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain('application/json');
    expect(r.headers()['content-disposition']).toBe(`attachment; filename="${NAME}"`);
    expect(await r.json()).toEqual(BACKUP);
    // The player's own storage has no such backup: it came from the drive.
    expect(await (await request.get(`${API}/JsonBackups/${NAME}`)).json())
      .toEqual({ Status: 'File Not Found', file: NAME, dir: 'JsonBackups' });

    // A name the drive does not hold.
    expect(await (await request.get(`${API}/JsonBackupsAlternate/fpp-tests-api-drive-none.json`)).json())
      .toEqual({ Status: 'File Not Found', file: 'fpp-tests-api-drive-none.json', dir: 'JsonBackupsAlternate' });
  });
});

test('with no backup drive chosen nothing is mounted, and the drive copy is not found', async ({ request }) => {
  await keepingSettings(async () => {
    standInDrive();
    for (const none of ['none', '']) {
      setSettingInFile('jsonConfigBackupUSBLocation', none);
      expect(await (await request.get(`${API}/JsonBackupsAlternate/${NAME}`)).json(), `"${none}"`)
        .toEqual({ Status: 'File Not Found', file: NAME, dir: 'JsonBackupsAlternate' });
      const answer = await restore(request, 'JsonBackupsAlternate', NAME, 'settings/system_settings');
      expect(answer.Success, JSON.stringify(answer)).toBe(false);
    }
    expect(mountCount()).toBe(0);
    expect(description()).not.toContain('fpp-tests-from-the-drive');
  });
});

test('one area of a backup on the drive is restored from it', async ({ request }) => {
  await keepingSettings(async () => {
    standInDrive();
    setSettingInFile('jsonConfigBackupUSBLocation', DEV);
    setSettingInFile('HostDescription', 'fpp-tests-before');
    const answer = await restore(request, 'JsonBackupsAlternate', NAME, 'settings/system_settings');
    expect(answer.Success, JSON.stringify(answer)).toBe(true);
    expect(description()).toBe('HostDescription = "fpp-tests-from-the-drive"');
    expect(mountCount()).toBeGreaterThan(0);
  });
});

test('a restore that cannot be made says why, and restores nothing', async ({ request }) => {
  await keepingSettings(async () => {
    setSettingInFile('HostDescription', 'fpp-tests-before');
    putFile(`${BACKUPS}/fpp-tests-api-drive-good.json`, JSON.stringify(BACKUP));
    putFile(`${BACKUPS}/fpp-tests-api-drive-bad.json`, '{ this is not a backup');
    const failed = async (dir: string, name: string, area: string, message: RegExp) => {
      const answer = await restore(request, dir, name, area);
      expect(answer.Success, `${dir}/${name} ${area}: ${JSON.stringify(answer)}`).toBe(false);
      expect([answer.Message].flat().join('\n')).toMatch(message);
    };
    // No such file, a file that is not JSON, an area there is no such thing
    // as, and a place backups are not kept.
    await failed('JsonBackups', 'fpp-tests-api-drive-none.json', 'settings/system_settings', /could not be decoded properly/);
    await failed('JsonBackups', 'fpp-tests-api-drive-bad.json', 'settings/system_settings', /could not be decoded properly/);
    await failed('JsonBackups', 'fpp-tests-api-drive-good.json', 'fpp-tests-no-such-area', /Invalid restore area specified/);
    await failed('Elsewhere', 'fpp-tests-api-drive-good.json', 'settings/system_settings', /could not be decoded properly/);
    expect(description()).toBe('HostDescription = "fpp-tests-before"');

    // The control: the good file, from where it is.
    const answer = await restore(request, 'JsonBackups', 'fpp-tests-api-drive-good.json', 'settings/system_settings');
    expect(answer.Success, JSON.stringify(answer)).toBe(true);
    expect(description()).toBe('HostDescription = "fpp-tests-from-the-drive"');
  });
});
