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

// 5c3a875b4: restoring a backup that holds a volume called SetVolume() with
// no argument (it had read the level from $_GET['volume'] when it was the
// fppxml.php handler), and the restore died there with a PHP error: the
// level was written to the settings file but never applied, and nothing
// after it in the backup was restored.
test("restoring a backup's volume applies it", async ({ request }) => {
  const volume = async () => (await (await request.get('/api/system/volume')).json()).volume;
  const before = await volume();
  const level = before === 37 ? 38 : 37;
  try {
    setLines({ HostDescription: '""' });
    // The volume first, then a setting after it: the restore must get past it.
    const r = await request.post('/backup.php', {
      multipart: {
        btnRestoreConfig: '1',
        restorearea: 'settings/system_settings',
        conffile: { name: 'fpp-tests-settings.json', mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(backupOf({ volume: String(level), HostDescription: 'fpp-tests-after-volume' }))) },
      },
    });
    expect(r.status(), 'the restore failed').toBe(200);
    expect(await r.text()).not.toMatch(/Fatal error|ArgumentCountError/);
    expect(line('volume')).toMatch(new RegExp(`^volume = "?${level}"?$`));
    // fppd was given the level, as the API reports it.
    await expect.poll(volume, { timeout: 10_000, message: "fppd's volume after the restore" }).toBe(level);
    expect(line('HostDescription'), 'the restore stopped at the volume').toBe('HostDescription = "fpp-tests-after-volume"');
  } finally {
    await request.post('/api/system/volume', { data: { volume: before } });
  }
});

// The email area with a password in the backup: the relay, its port and its
// login are written back and the mail configuration is rebuilt from them
// (ApplyEmailConfig), so a restored player can send mail without a visit to
// the Email settings page.
test.describe('the email area of a backup that holds the relay password', () => {
  const EXIM = `${MEDIA}/exim4`;
  const made = ['/etc/exim4', '/etc/aliases', '/etc/email-addresses', EXIM];
  let had: boolean[] = [];
  const there = (p: string) => inPlayer('sh', '-c', `test -e ${p} && echo y || echo n`).trim() === 'y';
  test.beforeEach(() => {
    had = made.map(there);
    inPlayer('mkdir', '-p', EXIM, '/etc/exim4');
  });
  test.afterEach(() => {
    made.forEach((p, i) => { if (!had[i]) inPlayer('rm', '-rf', p); });
  });
  const staged = (name: string) => inPlayer('sh', '-c', `cat ${EXIM}/${name} 2>/dev/null || true`);

  const mail = {
    emailenable: '1', emailserver: 'mail.fpp-tests.example', emailport: '465', emailuser: 'relay-user',
    emailpass: 'fpp-tests-relay-pw', emailfromuser: 'show@fpp-tests.example', emailfromtext: 'Show Player',
    emailtoemail: 'owner@fpp-tests.example',
  };
  const cleared = Object.fromEntries(Object.keys(mail).map((k) => [k, '""']));

  test("this player's own backup brings every email setting back and rebuilds the mail config", async ({ request }) => {
    setLines(cleared);
    await restore(request, backupOf({ ...mail, privacyConsent: consentFrom(ownUUID()) }), 'settings/email');
    for (const [key, value] of Object.entries(mail)) expect(line(key)).toBe(`${key} = "${value}"`);

    expect(staged('update-exim4.conf.conf')).toContain("dc_smarthost='mail.fpp-tests.example::465'");
    expect(staged('passwd.client')).toContain('mail.fpp-tests.example:relay-user:fpp-tests-relay-pw');
    expect(staged('aliases')).toContain('fpp: owner@fpp-tests.example');
    expect(staged('email-addresses')).toContain('fpp: show@fpp-tests.example');
    // Port 465 is implicit TLS, which the relay transport has to be told.
    expect(staged('99_fpp_smarthost')).toBe('REMOTE_SMTP_SMARTHOST_PROTOCOL=smtps\n');
  });

  test('a backup with no port or enable switch leaves those two as they are', async ({ request }) => {
    setLines({ ...cleared, emailport: '"2525"', emailenable: '"0"' });
    const { emailport: _p, emailenable: _e, ...rest } = mail;
    await restore(request, backupOf({ ...rest, privacyConsent: consentFrom(ownUUID()) }), 'settings/email');
    expect(line('emailserver')).toBe('emailserver = "mail.fpp-tests.example"');
    expect(line('emailpass')).toBe('emailpass = "fpp-tests-relay-pw"');
    expect(line('emailport')).toBe('emailport = "2525"');
    expect(line('emailenable')).toBe('emailenable = "0"');
  });

  test('a backup missing one of the relay settings restores none of them', async ({ request }) => {
    setLines(cleared);
    const { emailuser: _u, ...rest } = mail;
    await restore(request, backupOf({ ...rest, privacyConsent: consentFrom(ownUUID()) }), 'settings/email');
    for (const key of Object.keys(mail)) expect(line(key), key).toBe(`${key} = ""`);
    expect(staged('update-exim4.conf.conf')).toBe('');
  });

  test.describe("another player's backup", () => {
    const theirs = { ...mail, emailtoemail: 'previous-owner@elsewhere.example', privacyConsent: consentFrom(OTHER_UUID) };

    test("restores the relay and keeps this player's own destination in the settings (the control)", async ({ request }) => {
      setLines({ ...cleared, emailtoemail: '"me@fpp-tests.example"' });
      await restore(request, backupOf(theirs), 'settings/email');
      expect(line('emailserver')).toBe('emailserver = "mail.fpp-tests.example"');
      expect(line('emailpass')).toBe('emailpass = "fpp-tests-relay-pw"');
      expect(line('emailtoemail')).toBe('emailtoemail = "me@fpp-tests.example"');
      expect(staged('update-exim4.conf.conf')).toContain("dc_smarthost='mail.fpp-tests.example::465'");
    });

    test("does not point this player's mail at the backup's owner", async ({ request }) => {
      // The setting is withheld, but the mail config is then built from the
      // backup's own address: the aliases file sends fpp's mail to the
      // previous owner until the Email settings are next saved.  In FUTURE.md.
      test.fail(true, "the mail aliases are built with the foreign backup's destination address (FUTURE.md)");
      setLines({ ...cleared, emailtoemail: '"me@fpp-tests.example"' });
      await restore(request, backupOf(theirs), 'settings/email');
      expect(staged('aliases')).toContain('fpp: ');
      expect(staged('aliases')).not.toContain('previous-owner@elsewhere.example');
    });
  });
});
