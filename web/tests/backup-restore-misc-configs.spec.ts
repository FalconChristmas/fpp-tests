import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, exists, putFile, readFile, snapshotSettings } from './settings-file';

// The "Miscellaneous Settings" area of a configuration backup holds the .json
// files of the config folder that no other area owns, keyed by file name
// (www/backup.php BackupConfigFolderConfigs); restoring it writes each one
// back (RestoreConfigFolderConfigs).  The names come from the backup file,
// which may be one somebody uploaded: what the restore does with a name the
// backup side would never have put there.

test.skip(!container, 'seeds a backup and reads the config folder inside the run-web.sh container');

const CONFIG = `${MEDIA}/config`;
const BACKUP = 'fpp-tests-misc-configs.json';
const GPIO = `${CONFIG}/gpio.json`;

let restoreSettings: () => void;
let gpioBefore: string | undefined;
let markerBefore = false;

const clean = () => inPlayer('sh', '-c',
  `rm -f -- "${CONFIG}"/fpp-tests-misc* "${CONFIG}"/.fpp-tests-misc* "${MEDIA}"/fpp-tests-misc* "${BACKUPS}/${BACKUP}"`);

test.beforeEach(() => {
  restoreSettings = snapshotSettings();   // a restore raises the reboot flag
  gpioBefore = exists(GPIO) ? readFile(GPIO) : undefined;
  markerBefore = exists('/fpp_restored');
  inPlayer('mkdir', '-p', BACKUPS);
  clean();
});
test.afterEach(() => {
  clean();
  if (gpioBefore === undefined) inPlayer('rm', '-f', GPIO); else putFile(GPIO, gpioBefore);
  if (!markerBefore) inPlayer('rm', '-f', '/fpp_restored');
  restoreSettings();
});

async function restoreMisc(request: APIRequestContext, files: Record<string, unknown>) {
  putFile(`${BACKUPS}/${BACKUP}`, JSON.stringify({ fpp_backup_version: '7', misc_configs: { configs: [files] } }));
  const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${BACKUP}`, { data: 'misc_configs' });
  expect(r.status(), await r.text()).toBe(200);
  return r.json();
}

test('a .json file of the area is written back to the config folder, and a name with a path in it is skipped', async ({ request }) => {
  const answer = await restoreMisc(request, {
    'fpp-tests-misc.json': { joystick: 1, buttons: ['a', 'b'] },
    '../fpp-tests-misc-out.json': { outside: true },
    'sub/fpp-tests-misc-in.json': { inside: true },
  });
  expect(answer).toEqual({ Success: true, Message: { misc_configs: { configs: { VALID_DATA: true, ATTEMPT: true, SUCCESS: true } } } });
  expect(JSON.parse(readFile(`${CONFIG}/fpp-tests-misc.json`))).toEqual({ joystick: 1, buttons: ['a', 'b'] });
  // Written the way the config pages write: indented, one key a line.
  expect(readFile(`${CONFIG}/fpp-tests-misc.json`)).toContain('\n\t"joystick": 1,\n');
  expect(inPlayer('sh', '-c', `find "${MEDIA}" -maxdepth 3 -name 'fpp-tests-misc-*' | grep -v /backups/ || true`).trim(),
    'a name with a path in it was written').toBe('');
});

test('a name that is not a .json file is not written to the config folder', async ({ request }) => {
  // The backup never holds these: BackupConfigFolderConfigs keeps *.json only,
  // "no .htaccess, .htpassword or .db files".  The config folder also holds
  // .htaccess, .htpasswd and the saved interface.* files.
  await restoreMisc(request, {
    'fpp-tests-misc.json': { ok: true },
    'fpp-tests-misc.conf': 'password = x',
    '.fpp-tests-misc': ['AuthType None'],
  });
  expect(exists(`${CONFIG}/fpp-tests-misc.json`), 'the control: the .json file is restored').toBe(true);
  expect(exists(`${CONFIG}/fpp-tests-misc.conf`), 'a .conf file was written').toBe(false);
  expect(exists(`${CONFIG}/.fpp-tests-misc`), 'a dot-file was written').toBe(false);
});

test('another area\'s file named in other case is not written either', async ({ request }) => {
  // On a case-insensitive filesystem (macOS) GPIO.json is gpio.json.
  await restoreMisc(request, { 'fpp-tests-misc.json': { ok: true }, 'GPIO.json': [{ pin: 'fpp-tests' }] });
  expect(exists(`${CONFIG}/fpp-tests-misc.json`), 'the control: the .json file is restored').toBe(true);
  expect(exists(`${CONFIG}/GPIO.json`), 'GPIO.json was written').toBe(false);
});

test('an area whose every name is skipped is not reported as failed', async ({ request }) => {
  const answer = await restoreMisc(request, { 'fpp-tests-misc.conf': 'password = x' });
  expect(answer).toEqual({ Success: true, Message: { misc_configs: { configs: { VALID_DATA: true, ATTEMPT: true, SUCCESS: true } } } });
  expect(exists(`${CONFIG}/fpp-tests-misc.conf`)).toBe(false);
});

test('a file that belongs to another area is not written by restoring only this one', async ({ request }) => {
  // gpio.json is the "GPIO Input Triggers" area, which was not asked for.
  const mine = '[\n\t{ "pin": "fpp-tests: the triggers this player had" }\n]';
  putFile(GPIO, mine);
  await restoreMisc(request, {
    'fpp-tests-misc.json': { ok: true },
    'gpio.json': [{ pin: 'fpp-tests: from the backup' }],
  });
  expect(exists(`${CONFIG}/fpp-tests-misc.json`), 'the control: the .json file is restored').toBe(true);
  expect(readFile(GPIO), 'the GPIO inputs were replaced').toBe(mine);
});
