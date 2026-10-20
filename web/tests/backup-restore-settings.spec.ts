import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';
import { container, inPlayer } from './container';

// What a settings backup carries and what restoring one writes back over the
// player's own settings.  Each test names the fpp fix it guards; they were
// all made to www/backup.php on 2026-09-11, one on top of the other:
//
//   5e85a0030  restoring an automatic backup no longer wipes the email password
//   88f194700  do not corrupt settings containing double quotes
//   f6f4564ec  do not carry another player's privacy answers across a restore
//   b3817d527  properly restore a cleared credential the old redactor never blanked
//   8c2af486b  restoring another device's backup no longer takes over your logins
//
// Each test is red at its own fix's parent.  The backups below are built by
// hand except in the round trip, and restored through the Backup page's form
// one sub-area at a time (settings/system_settings, settings/email): a whole
// "settings" restore also rewrites commandPresets.json, the proxies and the
// time zone from whatever the backup holds.
//
// A restore applies what it writes (a UI password rewrites .htpasswd, a
// password switch rewrites Apache's password config) and marks the player for
// a reboot, so every test puts the settings file and those files back.

const MEDIA = '/home/fpp/media';
const SETTINGS = `${MEDIA}/settings`;
const KEEP = [SETTINGS, `${MEDIA}/config/.htpasswd`, `${MEDIA}/config/ui-password-config.conf`];
const SAVED = '/tmp/fpp-tests-backup-restore-settings';
const BACKUPS = `${MEDIA}/config/backups`;

// A real device identity that is not this player's.
const OTHER_UUID = '6b1f0e4a-2c39-4d8e-9a57-3f0c2d1e8b74';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test.beforeEach(() => {
  inPlayer('sh', '-c', `rm -rf ${SAVED} && mkdir -p ${SAVED} && for f in ${KEEP.join(' ')}; do ` +
    `[ -e "$f" ] && cp -p "$f" ${SAVED}/$(basename "$f"); done; ` +
    // A download keeps a copy among the player's backups.
    `mkdir -p ${BACKUPS} && ls ${BACKUPS} > ${SAVED}.backups`);
});

test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', `for f in ${KEEP.join(' ')}; do b=${SAVED}/$(basename "$f"); ` +
    `if [ -e "$b" ]; then cp -p "$b" "$f"; else rm -f "$f"; fi; done; ` +
    `cd ${BACKUPS} && ls | grep -vxF -f ${SAVED}.backups | xargs -r rm -f; ` +
    `rm -rf ${SAVED} ${SAVED}.backups /fpp_restored /fppos_upgraded`);
  // Apache reads the password config; it has to answer without one again.
  expect((await request.get('/api/fppd/version')).status()).toBe(200);
});

function writeFile(path: string, content: string) {
  execFileSync('docker', ['exec', '-i', container, 'sh', '-c', `cat > '${path}'`], { input: content });
}

// The settings file's own line for a key, as FPP wrote it, or undefined.
function line(key: string): string | undefined {
  return inPlayer('cat', SETTINGS).split('\n').find((l) => l.startsWith(`${key} = `) || l === `${key} =`);
}

// Sets keys in the settings file directly, without applying them.
function setLines(values: Record<string, string>) {
  const keys = Object.keys(values);
  const kept = inPlayer('cat', SETTINGS).split('\n').filter((l) => l !== '' && !keys.some((k) => l.startsWith(`${k} = `)));
  writeFile(SETTINGS, [...kept, ...keys.map((k) => `${k} = ${values[k]}`)].join('\n') + '\n');
}

// This player's identity, as the setup wizard stamped it on its consent record.
function ownUUID(): string {
  const consent = line('privacyConsent');
  expect(consent, 'the setup wizard left no privacy consent record').toBeDefined();
  const uuid = JSON.parse(consent!.slice('privacyConsent = '.length)).uuid;
  expect(uuid).toMatch(/^[0-9a-f-]{20,}$/i);
  return uuid;
}

function consentFrom(uuid: string): string {
  return JSON.stringify({
    settings: { statsPublish: { value: 'Disabled', date: '2026-01-01T00:00:00.000Z', via: 'wizard' } },
    version: 1, textHash: '0123456789abcdef', uuid,
  });
}

function backupOf(systemSettings: Record<string, string>, extra: object = {}) {
  return { fpp_backup_version: '8.0', settings: { system_settings: [systemSettings] }, ...extra };
}

// Restores one area of a backup through the Backup page, as its form does.
async function restore(request: APIRequestContext, backup: object, area: string) {
  const r = await request.post('/backup.php', {
    multipart: {
      btnRestoreConfig: '1',
      restorearea: area,
      conffile: { name: 'fpp-tests-settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) },
    },
  });
  expect(r.ok(), `restore of ${area}`).toBe(true);
}

// 88f194700: the backup read the settings file with parse_ini_string(), which
// takes '"' as a string delimiter and drops it, so a value holding quotes --
// privacyConsent, a JSON object FPP writes unquoted -- went into every backup
// as {a:b c}, and a restore wrote that back over the good value.
test('a backup and its restore keep a setting that contains double quotes', async ({ request }) => {
  const value = '{"name":"a b","on":true,"list":["x","y"]}';
  setLines({ fppTestsQuoted: value });

  const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'settings' } });
  expect(dl.ok()).toBe(true);
  const backup = await dl.json();
  const carried = backup.settings.system_settings[0];
  // The control: the backup read the settings file.
  expect(carried.HostName).toBeDefined();
  expect(carried.fppTestsQuoted, 'the backup mangled the value').toBe(value);

  // Restore only that setting from it, over a changed one.
  setLines({ fppTestsQuoted: '"changed"' });
  await restore(request, { ...backup, settings: { system_settings: [{ fppTestsQuoted: carried.fppTestsQuoted }] } },
    'settings/system_settings');
  expect(line('fppTestsQuoted')).toBe(`fppTestsQuoted = ${value}`);
});

// 5e85a0030: a backup taken while "Protect sensitive data" existed (the
// automatic backups every player keeps were) has '' where a credential was
// blanked.  Restoring one wrote that '' over the player's working email
// password.
test('restoring a protected backup keeps the email password', async ({ request }) => {
  setLines({ emailpass: '"fpp-tests-mail-pw"', HostDescription: '""' });
  await restore(request, backupOf({ emailpass: '', HostDescription: 'fpp-tests-protected' }, { protected: true }),
    'settings/system_settings');
  // The control: the restore wrote the backup's settings.
  expect(line('HostDescription')).toBe('HostDescription = "fpp-tests-protected"');
  expect(line('emailpass'), 'the restore wiped the email password').toBe('emailpass = "fpp-tests-mail-pw"');
});

// b3817d527: 5e85a0030 kept this player's value for every password-type
// setting a protected backup had blank, but the old redactor only ever
// blanked emailpass, emailgpass, password and secret.  An MQTT password the
// user had really cleared was not restored.
test('restoring a protected backup clears a credential the user cleared', async ({ request }) => {
  setLines({ MQTTPassword: '"fpp-tests-old-mqtt"', HostDescription: '""' });
  await restore(request, backupOf({ MQTTPassword: '', HostDescription: 'fpp-tests-cleared' }, { protected: true }),
    'settings/system_settings');
  expect(line('HostDescription')).toBe('HostDescription = "fpp-tests-cleared"');
  expect(line('MQTTPassword'), 'the cleared MQTT password was not restored').toBe('MQTTPassword = ""');
});

// f6f4564ec: the privacy step's answers, the jurisdiction they were given
// under and FPP_UUID (which get_uuid honours) were restored from another
// player's backup, so this player published stats on someone else's say-so.
// They are restored only from this player's own backup.
test.describe('privacy answers', () => {
  const answers = {
    statsPublish: 'Disabled', ShareCrashData: '1', FetchVendorLogos: '0', SendVendorSerial: '0',
    emailAddress: 'fpp-tests@example.com', LegalJurisdiction: 'GB', FPP_UUID: OTHER_UUID,
  };
  const local = {
    statsPublish: '"Enabled"', ShareCrashData: '"0"', FetchVendorLogos: '"1"', SendVendorSerial: '"1"',
    emailAddress: '""', LegalJurisdiction: '"US"', HostDescription: '""',
  };

  test("another player's privacy answers are not restored", async ({ request }) => {
    setLines(local);
    await restore(request, backupOf({ ...answers, privacyConsent: consentFrom(OTHER_UUID), HostDescription: 'fpp-tests-foreign' }),
      'settings/system_settings');
    expect(line('HostDescription')).toBe('HostDescription = "fpp-tests-foreign"');
    for (const key of Object.keys(answers)) {
      const want = key in local ? `${key} = ${(local as Record<string, string>)[key]}` : undefined;
      expect(line(key), `${key} came from the other player`).toBe(want);
    }
  });

  test("this player's own backup restores them", async ({ request }) => {
    setLines(local);
    const { FPP_UUID: _, ...own } = answers;
    await restore(request, backupOf({ ...own, privacyConsent: consentFrom(ownUUID()), HostDescription: 'fpp-tests-own' }),
      'settings/system_settings');
    expect(line('HostDescription')).toBe('HostDescription = "fpp-tests-own"');
    for (const [key, value] of Object.entries(own)) {
      expect(line(key)).toBe(`${key} = "${value}"`);
    }
  });
});

// 8c2af486b: restoring another player's backup applied its logins: its UI
// password (rewriting .htpasswd), the password switch, its OS password, and
// the address mail goes to, from both the settings and the email areas.  They
// stay this player's own unless the backup is.
test("another player's backup leaves this player's logins alone", async ({ request }) => {
  const local = {
    password: '"fpp-tests-local-ui"', passwordEnable: '"1"', osPassword: '"fpp-tests-local-os"', osPasswordEnable: '"0"',
    emailtoemail: '"local@example.com"', HostDescription: '""',
  };
  setLines(local);
  inPlayer('rm', '-f', `${MEDIA}/config/.htpasswd`);
  const backup = backupOf({
    password: 'fpp-tests-their-ui', passwordVerify: 'fpp-tests-their-ui', passwordEnable: '0',
    osPassword: 'fpp-tests-their-os', osPasswordVerify: 'fpp-tests-their-os', osPasswordEnable: '1',
    emailtoemail: 'them@example.com', emailserver: 'mail.example.com', emailuser: 'them@example.com', emailpass: '',
    emailfromuser: 'them@example.com', emailfromtext: 'Their FPP',
    privacyConsent: consentFrom(OTHER_UUID), HostDescription: 'fpp-tests-their-logins',
  });

  await restore(request, backup, 'settings/system_settings');
  expect(line('HostDescription')).toBe('HostDescription = "fpp-tests-their-logins"');
  for (const key of ['password', 'passwordEnable', 'osPassword', 'osPasswordEnable', 'emailtoemail']) {
    expect(line(key), `${key} came from the other player`).toBe(`${key} = ${(local as Record<string, string>)[key]}`);
  }
  expect(inPlayer('sh', '-c', `test -e ${MEDIA}/config/.htpasswd && echo written || echo absent`).trim(),
    "the other player's UI password was applied").toBe('absent');

  // The email area restores the relay, but not where mail goes.
  setLines({ emailserver: '""' });
  await restore(request, backup, 'settings/email');
  expect(line('emailserver')).toBe('emailserver = "mail.example.com"');
  expect(line('emailtoemail'), 'the email area took the other player\'s address').toBe('emailtoemail = "local@example.com"');
});
