import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import http from 'http';
import { container, inPlayer } from './container';
import { MEDIA, SETTINGS, readFile, setSettingInFile, settingInFile } from './settings-file';

// Regression: 9dab6430f ("Fix password loss and plaintext leak in protected
// JSON config backup/restore", #2805). "Protect sensitive data" blanked a
// backup's password and osPassword but never its passwordVerify and
// osPasswordVerify, so a protected backup still held the real passwords in
// the verify fields. A settings restore wrote every key back: the blank
// password went to the settings file and was applied, which made the UI and
// OS passwords the default 'falcon', and the verify fields were written to
// the settings file in plain text. Since the fix a restore takes a blank
// password from its verify field, leaves this player's password alone when
// both are blank (a '' OS password means 'falcon'), and never writes a verify
// field.
//
// The receiving ends are the ones a login meets: Apache's basic auth against
// the .htpasswd the restore wrote, and the fpp account's password hash, which
// the real chpasswd sets (the player has no fpp account, so the test makes one
// for its length) and the system's crypt() checks.

const HTPASSWD = `${MEDIA}/config/.htpasswd`;
const PWCONF = `${MEDIA}/config/ui-password-config.conf`;
const KEEP = [SETTINGS, HTPASSWD, PWCONF];
const SAVED = '/tmp/fpp-tests-backup-restore-password-verify';
const BACKUPS = `${MEDIA}/config/backups`;

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

// A request on a connection of its own, so a kept-alive one from before an
// Apache reload cannot answer under the old config.
function status(path: string, password?: string): Promise<number> {
  const base = test.info().project.use.baseURL!;
  const headers: Record<string, string> = password === undefined ? {} :
    { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') };
  return new Promise((resolve, reject) => {
    http.get(new URL(path, base), { headers, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on('error', reject);
  });
}

async function reloadApache() {
  const generation = () => Number(/ParentServerConfigGeneration: (\d+)/.exec(
    inPlayer('curl', '-s', 'http://127.0.0.1/server-status?auto'))?.[1] ?? NaN);
  const before = generation();
  inPlayer('apache2ctl', 'graceful');
  await expect.poll(generation, { timeout: 10_000 }).toBeGreaterThan(before);
}

const hasAccount = () => inPlayer('sh', '-c', 'id fpp >/dev/null 2>&1 && echo y || echo n').trim() === 'y';
const shadowHash = () => inPlayer('sh', '-c', 'getent shadow fpp | cut -d: -f2').trim();

// Whether `password` is the fpp account's password, by the crypt() a login uses.
function isOSPassword(password: string): boolean {
  return inPlayer('perl', '-e', 'my ($h, $p) = @ARGV; print crypt($p, $h) eq $h ? "yes" : "no"', shadowHash(), password).trim() === 'yes';
}

// Whether .htpasswd holds `password` for admin, by Apache's own htpasswd.
function isUIPassword(password: string): boolean {
  return inPlayer('sh', '-c', `htpasswd -vb '${HTPASSWD}' admin '${password}' >/dev/null 2>&1 && echo yes || echo no`).trim() === 'yes';
}

let madeAccount = false;
test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${SAVED} && mkdir -p ${SAVED} && for f in ${KEEP.join(' ')}; do ` +
    `[ -e "$f" ] && cp -p "$f" ${SAVED}/$(basename "$f"); done; ` +
    `mkdir -p ${BACKUPS} && ls ${BACKUPS} > ${SAVED}.backups`);
  test.skip(hasAccount(), 'the player has an fpp account of its own');
  inPlayer('sh', '-c', "useradd -M -d /home/fpp fpp && echo 'fpp:fpp-tests-os-before' | chpasswd");
  madeAccount = true;
});

test.afterEach(async () => {
  if (madeAccount) inPlayer('userdel', 'fpp');
  madeAccount = false;
  inPlayer('sh', '-c', `for f in ${KEEP.join(' ')}; do b=${SAVED}/$(basename "$f"); ` +
    `if [ -e "$b" ]; then cp -p "$b" "$f"; else rm -f "$f"; fi; done; ` +
    `cd ${BACKUPS} && ls | grep -vxF -f ${SAVED}.backups | xargs -r rm -f; ` +
    `rm -rf ${SAVED} ${SAVED}.backups /fpp_restored /fppos_upgraded`);
  // The restore may have turned the password on; Apache has to answer
  // without one again.
  await reloadApache();
  await expect.poll(() => status('/api/fppd/version'), { timeout: 10_000 }).toBe(200);
});

// Restores the settings sub-area of a backup through the Backup page's form.
async function restore(request: APIRequestContext, systemSettings: Record<string, string>, extra: object = {}) {
  const backup = { fpp_backup_version: '8.0', settings: { system_settings: [systemSettings] }, ...extra };
  const r = await request.post('/backup.php', {
    multipart: {
      btnRestoreConfig: '1',
      restorearea: 'settings/system_settings',
      conffile: { name: 'fpp-tests-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) },
    },
  });
  expect(r.ok()).toBe(true);
}

test('a protected backup restores the passwords its verify fields hold, and never writes the verify fields', async ({ request }) => {
  test.setTimeout(90_000);
  setSettingInFile('password', 'fpp-tests-ui-before');
  setSettingInFile('passwordEnable', '0');
  setSettingInFile('osPassword', 'fpp-tests-os-before');
  setSettingInFile('HostDescription', '');
  expect(isOSPassword('fpp-tests-os-before'), 'the control: crypt() checks the password').toBe(true);

  // What a protected backup made before the redaction covered the verify
  // fields carries; no consent record, so its credentials are carried.
  await restore(request, {
    password: '', passwordVerify: 'fpp-tests-ui-restored', passwordEnable: '1',
    osPassword: '', osPasswordVerify: 'fpp-tests-os-restored',
    HostDescription: 'fpp-tests-verify',
  }, { protected: true });

  // The control: the restore wrote the backup's settings.
  expect(settingInFile('HostDescription')).toBe('fpp-tests-verify');
  expect(settingInFile('password'), 'the UI password was not taken from its verify field').toBe('fpp-tests-ui-restored');
  expect(settingInFile('osPassword'), 'the OS password was not taken from its verify field').toBe('fpp-tests-os-restored');
  const text = readFile(SETTINGS);
  expect(text, 'a verify field was written to the settings file').not.toMatch(/^\s*(passwordVerify|osPasswordVerify)\s*=/m);

  // Apache now asks for the restored password, and takes it.
  expect(isUIPassword('fpp-tests-ui-restored'), '.htpasswd does not hold the restored password').toBe(true);
  await expect.poll(() => status('/api/fppd/version'), { timeout: 15_000 }).toBe(401);
  expect(await status('/api/fppd/version', 'fpp-tests-ui-restored'), 'the restored UI password is refused').toBe(200);
  expect(await status('/api/fppd/version', 'falcon'), 'the default UI password is accepted').toBe(401);
  // And the fpp account has the restored one.
  expect(isOSPassword('fpp-tests-os-restored'), 'the fpp account does not have the restored password').toBe(true);
  expect(isOSPassword('falcon'), 'the fpp account was reset to the default password').toBe(false);
});

test("a backup with blank passwords leaves this player's passwords alone", async ({ request }) => {
  setSettingInFile('password', 'fpp-tests-ui-before');
  setSettingInFile('passwordEnable', '0');
  setSettingInFile('osPassword', 'fpp-tests-os-before');
  setSettingInFile('HostDescription', '');
  // A .htpasswd for the player's own password, as setting it writes one.
  inPlayer('htpasswd', '-cbB', HTPASSWD, 'admin', 'fpp-tests-ui-before');
  const htpasswd = readFile(HTPASSWD);
  const shadow = shadowHash();

  // Not protected: a blank here is not a redaction.
  await restore(request, { password: '', osPassword: '', HostDescription: 'fpp-tests-blank' });

  expect(settingInFile('HostDescription')).toBe('fpp-tests-blank');
  expect(settingInFile('password'), 'the blank UI password was written').toBe('fpp-tests-ui-before');
  expect(settingInFile('osPassword'), 'the blank OS password was written').toBe('fpp-tests-os-before');
  expect(readFile(HTPASSWD), '.htpasswd was rewritten').toBe(htpasswd);
  expect(isUIPassword('falcon'), 'the UI password became the default').toBe(false);
  expect(shadowHash(), 'the fpp account password was changed').toBe(shadow);
  expect(isOSPassword('fpp-tests-os-before')).toBe(true);
});
