import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, deviceUUID, exists, putFile, readFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// What a settings restore carries from the player that wrote the backup.
//
// The privacy step's answers, the jurisdiction they were given under and the
// device identity belong to the player that answered them; a box restored from
// another player's backup answers the step itself. Before fpp f6f4564ec ("do
// not carry another player's privacy answers across a restore") they were
// restored like any other setting, so a box could start publishing statistics
// on somebody else's decision.
//
// The login credentials (password, osPassword) and the mail destination are
// applied, not just stored: password rewrites .htpasswd, osPassword runs
// chpasswd. Before fpp 8c2af486b ("restoring another devices backup no longer
// takes over your logins") another player's backup locked you out of the box
// in front of you with its passwords. The same commit stopped two players
// that both report the identity "Unknown" from counting as the same player.
//
// 8c2af486b withheld the credentials from any backup it could not prove was
// this player's own, and every backup written before 88f194700 carries the
// consent record with its quotes stripped, which does not decode: restoring a
// player's own older backup dropped its UI password. Since fpp 06dda180f
// ("restoring your own older backup no longer turns off web authentication")
// the uuid is read out of a stripped record, and a backup with no record at
// all keeps its credentials (only a provably foreign one loses them).

const FOREIGN = '7d5e1c2a-3b4f-4c6d-8e9f-0a1b2c3d4e5f';
const HTPASSWD = `${MEDIA}/config/.htpasswd`;
const BACKUP = 'fpp-tests-provenance_20260101000000.json';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
let hadHtpasswd: boolean;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  hadHtpasswd = exists(HTPASSWD);
});
test.afterEach(() => {
  restoreSettings();
  if (!hadHtpasswd) inPlayer('rm', '-f', HTPASSWD);
  inPlayer('rm', '-f', `${BACKUPS}/${BACKUP}`, '/fpp_restored', `${MEDIA}/config/proxies`);
});

function consentRecord(uuid: string) {
  return JSON.stringify({ settings: { statsPublish: { value: 'Disabled', date: '2026-01-01T00:00:00.000Z', via: 'wizard' } }, version: 1, uuid });
}

// The record as backups written before 88f194700 carry it: parse_ini_string()
// took every double quote out.
function stripped(record: string) {
  return record.replace(/"/g, '');
}

async function restore(request: APIRequestContext, backup: object, area = 'settings/system_settings') {
  putFile(`${BACKUPS}/${BACKUP}`, JSON.stringify({ fpp_backup_version: '8.0', protected: false, backup_comment: 'fpp-tests', ...backup }));
  const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${BACKUP}`, { data: area });
  const body = await r.text();
  expect(r.status(), body).toBe(200);
  const reply = JSON.parse(body);
  expect(reply.Success, body).toBe(true);
  return reply;
}

// A backup whose settings carry the privacy answers, identity, credentials and
// one plain setting, all different from this player's.
function systemSettings(extra: Record<string, string>) {
  return {
    HostDescription: 'fpp-tests-restored',
    statsPublish: 'Disabled',
    LegalJurisdiction: 'GB',
    password: 'fpp-tests-ui-pw',
    osPassword: 'fpp-tests-os-pw',
    emailtoemail: 'restored@example.com',
    ...extra,
  };
}

function before() {
  setSettingInFile('statsPublish', 'Enabled');
  setSettingInFile('LegalJurisdiction', 'US');
  setSettingInFile('emailtoemail', 'mine@example.com');
  setSettingInFile('osPassword', undefined);
  setSettingInFile('HostDescription', '');
}

test("another player's backup restores its settings, not its privacy answers or identity", async ({ request }) => {
  before();
  await restore(request, { settings: { system_settings: [systemSettings({ privacyConsent: consentRecord(FOREIGN), FPP_UUID: 'fpp-tests-foreign-id' })] } });
  // The control: the restore ran and wrote what it should.
  expect(settingInFile('HostDescription')).toBe('fpp-tests-restored');
  expect(settingInFile('statsPublish'), "another player's privacy answer was restored").toBe('Enabled');
  expect(settingInFile('LegalJurisdiction')).toBe('US');
  expect(settingInFile('FPP_UUID'), "another player's identity was adopted").toBeUndefined();
});

test("another player's backup does not bring its logins", async ({ request }) => {
  expect(hadHtpasswd, 'the player already has a UI password file').toBe(false);
  before();
  await restore(request, { settings: { system_settings: [systemSettings({ privacyConsent: consentRecord(FOREIGN) })] } });
  expect(settingInFile('HostDescription')).toBe('fpp-tests-restored');
  expect(exists(HTPASSWD), "another player's UI password was applied").toBe(false);
  expect(settingInFile('password')).toBeUndefined();
  expect(settingInFile('osPassword'), "another player's OS password was restored").toBeUndefined();
  expect(settingInFile('emailtoemail'), "another player's mail destination was restored").toBe('mine@example.com');
});

test('two players that both report the identity "Unknown" are not the same player', async ({ request }) => {
  const cache = inPlayer('cat', '/tmp/fpp_uuid');
  // getSystemUUID() rereads an invalid cache through get_uuid, which takes the
  // developer FPP_UUID setting first.
  setSettingInFile('FPP_UUID', 'Unknown');
  putFile('/tmp/fpp_uuid', 'Unknown\n');
  try {
    expect(deviceUUID()).toBe('Unknown');
    before();
    await restore(request, { settings: { system_settings: [systemSettings({ privacyConsent: consentRecord('Unknown') })] } });
    expect(settingInFile('HostDescription')).toBe('fpp-tests-restored');
    expect(settingInFile('statsPublish'), 'an "Unknown" backup counted as this player\'s own').toBe('Enabled');
    expect(settingInFile('LegalJurisdiction')).toBe('US');
  } finally {
    putFile('/tmp/fpp_uuid', cache);
  }
});

test("this player's own backup restores everything, even one with the record's quotes stripped", async ({ request }) => {
  const own = consentRecord(deviceUUID());
  for (const record of [own, stripped(own)]) {
    before();
    const mine = settingInFile('privacyConsent');
    await restore(request, { settings: { system_settings: [systemSettings({ privacyConsent: record })] } });
    expect(settingInFile('HostDescription'), record).toBe('fpp-tests-restored');
    expect(settingInFile('statsPublish'), `own backup's privacy answer not restored: ${record}`).toBe('Disabled');
    expect(settingInFile('LegalJurisdiction'), record).toBe('GB');
    expect(settingInFile('emailtoemail'), `own backup's credentials withheld: ${record}`).toBe('restored@example.com');
    expect(settingInFile('osPassword'), record).toBe('fpp-tests-os-pw');
    if (record !== own) {
      // A stripped record is not written over one that still decodes.
      expect(settingInFile('privacyConsent')).toBe(mine);
    }
  }
});

test('a backup with no consent record keeps its credentials but not its privacy answers', async ({ request }) => {
  before();
  await restore(request, { settings: { system_settings: [systemSettings({})] } });
  expect(settingInFile('HostDescription')).toBe('fpp-tests-restored');
  expect(settingInFile('statsPublish')).toBe('Enabled');
  expect(settingInFile('emailtoemail'), 'a backup of unknown origin lost its mail destination').toBe('restored@example.com');
  expect(settingInFile('osPassword'), 'a backup of unknown origin lost its OS password').toBe('fpp-tests-os-pw');
});

// Backups made while "Protect Sensitive Data" existed (protected: true) carry
// '' where the old redactor blanked a value: emailpass, emailgpass, password
// and secret, and nothing else. Before fpp 5e85a0030 ("restoring an automatic
// backup no longer wipes the email password") that '' was written over this
// player's working email password -- every automatic backup is a protected one.
// 5e85a0030 also kept every password-type setting, so a cleared MQTTPassword
// (which the redactor never touched) could not be restored; fpp b3817d527
// ("properly restore a cleared credential the old redactor never blanked")
// narrowed it to the four keys.
test("a protected backup's blanked email password leaves this player's in place", async ({ request }) => {
  const settings = (prot: boolean) => ({
    protected: prot,
    settings: { system_settings: [{ HostDescription: `fpp-tests-protected-${prot}`, emailpass: '', MQTTPassword: '', privacyConsent: consentRecord(deviceUUID()) }] },
  });
  for (const prot of [true, false]) {
    setSettingInFile('emailpass', 'fpp-tests-mail-pw');
    setSettingInFile('MQTTPassword', 'fpp-tests-mqtt-pw');
    await restore(request, settings(prot));
    expect(settingInFile('HostDescription')).toBe(`fpp-tests-protected-${prot}`);
    expect(settingInFile('MQTTPassword'), `a cleared MQTTPassword was not restored (protected ${prot})`).toBe('');
    expect(settingInFile('emailpass'), `protected ${prot}`).toBe(prot ? 'fpp-tests-mail-pw' : '');
  }
});

// Regression: 88f194700 ("do not corrupt settings containing double quotes").
// Backups read the settings file with parse_ini_string(), which strips every
// double quote, so the privacyConsent JSON arrived as {settings:{...}} and no
// longer decoded; restoring it wrote that back.
test('a backup carries a setting with double quotes in it intact', async ({ request }) => {
  const record = settingInFile('privacyConsent');
  expect(record, 'the setup wizard left no consent record').toBeTruthy();
  const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests quotes' })).json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  const file = String(made.backup_file_path).split('/').pop()!;
  try {
    const backup = JSON.parse(readFile(`${BACKUPS}/${file}`));
    const carried = backup.settings.system_settings[0].privacyConsent;
    expect(carried, 'the backup took the quotes out of the record').toBe(record);
    expect(JSON.parse(carried).uuid).toBe(deviceUUID());
  } finally {
    await request.delete(`/api/backups/configuration/JsonBackups/${file}`);
  }
});

// Regression: bc7b1c38a ("restoring an older backup no longer reports the
// privacy record as failed"). The plugin privacy acceptance step runs on every
// Settings restore; with no record in the backup (every backup made before the
// record existed) it set ATTEMPT=false, which the results show as a red
// "Failed" line.
test('a backup with no plugin privacy record does not report it as failed', async ({ request }) => {
  const made = await (await request.post('/api/backups/configuration', { data: 'fpp-tests no record' })).json();
  expect(made.success, JSON.stringify(made)).toBe(true);
  const file = String(made.backup_file_path).split('/').pop()!;
  const RECORD = `${MEDIA}/config/pluginPrivacyAccepted.json`;
  const hadRecord = exists(RECORD);
  try {
    const backup = JSON.parse(readFile(`${BACKUPS}/${file}`));
    expect(backup.settings.pluginPrivacyAccepted).toEqual([null]);
    const plain = await restore(request, backup, 'settings');
    // The control: the settings themselves were restored.
    expect(plain.Message.settings.system_settings.ATTEMPT).toBe(true);
    expect(plain.Message.settings.pluginPrivacyAccepted?.ATTEMPT, JSON.stringify(plain)).toBeUndefined();

    // Another player's record is reported as not restored, and not written.
    const accepted = { plugins: { 'fpp-tests-plugin': { accepted: true } } };
    backup.settings.pluginPrivacyAccepted = [accepted];
    backup.settings.system_settings[0].privacyConsent = consentRecord(FOREIGN);
    const foreign = await restore(request, backup, 'settings');
    expect(foreign.Message.settings.pluginPrivacyAccepted?.ATTEMPT, JSON.stringify(foreign)).toBe(false);
    expect(exists(RECORD) ? readFile(RECORD) : '').not.toContain('fpp-tests-plugin');
  } finally {
    if (!hadRecord) inPlayer('rm', '-f', RECORD);
    await request.delete(`/api/backups/configuration/JsonBackups/${file}`);
  }
});
