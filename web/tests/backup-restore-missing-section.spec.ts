import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { BACKUPS, MEDIA, deviceUUID, putFile, readFile, settingInFile, snapshotSettings } from './settings-file';

// Regression: a83ed39e2 ("a settings restore from a backup with no proxies
// section restores the rest"). The proxies sub-area implode()d the backup's
// proxies data without checking it was there, so a backup without it (made by
// hand, or before proxies were backed up) was a PHP fatal part way through the
// restore: the email and time zone sub-areas after it never ran, and the reply
// was the fatal's HTML.

const BACKUP = 'fpp-tests-no-proxies_20260101000000.json';

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('a settings restore from a backup with no proxies section restores the sub-areas after it', async ({ request }) => {
  const restoreSettings = snapshotSettings();
  const presets = JSON.parse(readFile(`${MEDIA}/config/commandPresets.json`));
  const own = JSON.stringify({ settings: {}, version: 1, uuid: deviceUUID() });
  putFile(`${BACKUPS}/${BACKUP}`, JSON.stringify({
    fpp_backup_version: '8.0', protected: false, backup_comment: 'fpp-tests no proxies',
    settings: {
      system_settings: [{
        privacyConsent: own, HostDescription: 'fpp-tests-no-proxies',
        emailserver: 'smtp.example.com', emailuser: 'fpp-tests@example.com', emailpass: '',
        emailfromuser: 'fpp-tests@example.com', emailfromtext: 'fpp-tests-from-text', emailtoemail: 'fpp-tests@example.com',
      }],
      commandPresets: [presets],
      pluginPrivacyAccepted: [null],
    },
  }));
  try {
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${BACKUP}`, { data: 'settings' });
    const body = await r.text();
    expect(body, 'the restore died part way').not.toContain('Fatal error');
    const reply = JSON.parse(body);
    expect(reply.Success, body).toBe(true);
    // The sub-areas before the missing one, and the one after it.
    expect(settingInFile('HostDescription')).toBe('fpp-tests-no-proxies');
    expect(reply.Message.settings.email?.ATTEMPT, body).toBe(true);
    expect(settingInFile('emailfromtext')).toBe('fpp-tests-from-text');
    // Nothing to restore is not a failure to restore.
    expect(reply.Message.settings.proxies?.ATTEMPT, body).toBeUndefined();
  } finally {
    restoreSettings();
    inPlayer('rm', '-f', `${BACKUPS}/${BACKUP}`, '/fpp_restored');
  }
});

// Regression: 860150034 ("a settings restore from a backup with no command
// presets keeps this player's"). A backup made on a player with no
// commandPresets.json carries the section as [null], and restoring it wrote
// "null" over this player's presets.
test("a settings restore from a backup with no command presets keeps this player's", async ({ request }) => {
  const restoreSettings = snapshotSettings();
  const PRESETS = `${MEDIA}/config/commandPresets.json`;
  const before = readFile(PRESETS);
  expect(JSON.parse(before).commands?.length, 'the player has no presets to lose').toBeGreaterThan(0);
  putFile(`${BACKUPS}/${BACKUP}`, JSON.stringify({
    fpp_backup_version: '8.0', protected: false, backup_comment: 'fpp-tests no presets',
    settings: {
      system_settings: [{ HostDescription: 'fpp-tests-no-presets' }],
      commandPresets: [null], pluginPrivacyAccepted: [null], proxies: [['']], timezone: [false],
    },
  }));
  try {
    const r = await request.post(`/api/backups/configuration/restore/JsonBackups/${BACKUP}`, { data: 'settings' });
    const body = await r.text();
    const reply = JSON.parse(body);
    // The control: the restore ran.
    expect(settingInFile('HostDescription')).toBe('fpp-tests-no-presets');
    expect(readFile(PRESETS), 'the presets were overwritten').toBe(before);
    expect(reply.Message.settings.commandPresets?.ATTEMPT, body).toBeUndefined();
  } finally {
    putFile(PRESETS, before);
    restoreSettings();
    inPlayer('rm', '-f', `${BACKUPS}/${BACKUP}`, '/fpp_restored');
  }
});

