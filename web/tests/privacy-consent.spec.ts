import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';
import { container, inPlayer } from './container';
import { SETTINGS, dropSettings, keepingSettings, readSettingsFile } from './privacy-helpers';

// The privacy answers and the consent record behind them, and the gate that
// sends every page to the setup wizard until both exist.  The setup project
// has finished the wizard (US) before this runs.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

async function sentToSetup(request: APIRequestContext) {
  return (await (await request.get('/index.php')).text()).includes('url=initialSetup.php');
}

test('consent is recorded per choice, with what was shown and where', async ({ request }) => {
  // Feature: bcb8c0e0e.  POST /api/privacy/consent stamps only the choices it
  // is given, each with its own value, date and origin, and the record with
  // the disclosure version, the text's hash and this player's UUID; the
  // record is one JSON object in the settings file.
  await keepingSettings(async () => {
    const stamp = (via: string, date: string, settings: object) =>
      request.post('/api/privacy/consent', { data: { via, date, settings } });
    expect((await (await stamp('wizard', '2026-03-01T10:00:00Z', { statsPublish: 'Enabled' })).json()).Status).toBe('OK');
    expect((await (await stamp('settings', '2026-09-01T10:00:00Z', { ShareCrashData: '2' })).json()).Status).toBe('OK');
    const refused = await (await stamp('api', '2026-09-02T10:00:00Z', { ShareCrashData: '3' })).json();
    expect(refused.Status, 'a consent from nowhere was recorded').toBe('Error');

    const got = await (await request.get('/api/privacy/consent')).json();
    const rec = got.consent;
    expect(rec.settings.statsPublish, 'a later stamp for another choice moved this one').toEqual(
      { value: 'Enabled', date: '2026-03-01T10:00:00Z', via: 'wizard' });
    expect(rec.settings.ShareCrashData).toEqual({ value: '2', date: '2026-09-01T10:00:00Z', via: 'settings' });
    expect(rec.version).toBe(got.currentVersion);
    expect(rec.textHash).toBe(got.currentTextHash);
    const status = await (await request.get('/api/statistics/usage?force=1')).json();
    expect(rec.uuid).toBe(status.uuid);
    // The statistics upload carries its own stamp and no other.
    expect(status.consent).toEqual({ value: 'Enabled', date: '2026-03-01T10:00:00Z', via: 'wizard',
      version: got.currentVersion, textHash: got.currentTextHash });

    const line = readSettingsFile().split('\n').find((l) => l.startsWith('privacyConsent '));
    expect(line, 'no privacyConsent line').toBeDefined();
    expect(JSON.parse(line!.replace(/^privacyConsent = /, ''))).toEqual(rec);
  });
});

for (const key of ['LegalJurisdiction', 'statsPublish', 'ShareCrashData', 'FetchVendorLogos', 'SendVendorSerial']) {
  test(`a player with no ${key} answer is sent back to setup`, async ({ request }) => {
    // Regression: 06d559fb9 -- the gate checked LegalJurisdiction only, so a
    //   restored configuration with no privacy answers ran on the shipped
    //   defaults with nothing recorded and nothing left to ask.
    // Feature: 36e18e02b -- the gate requires the legal jurisdiction.
    expect(await sentToSetup(request), 'the control: a set-up player is not sent to setup').toBe(false);
    await keepingSettings(async () => {
      dropSettings(key);
      expect(await sentToSetup(request), `no ${key}, and the pages carried on`).toBe(true);
      // initialSetup.php itself never redirects, or there would be no way out.
      expect(await (await request.get('/initialSetup.php')).text()).not.toContain('url=initialSetup.php');
    });
  });
}

test('the contact address is optional: no emailAddress does not send a player to setup', async ({ request }) => {
  // 06d559fb9: emailAddress is deliberately not required.
  await keepingSettings(async () => {
    dropSettings('emailAddress');
    expect(await sentToSetup(request)).toBe(false);
  });
});

test('a consent record for an older disclosure version sends a player to setup, a newer one does not', async ({ request }) => {
  // Feature: cdfb4f6f3.  The answers record which disclosure text they were
  // given against; a lower version than the current one re-prompts, so a
  // material change to what is sent asks everyone again.  (bcb8c0e0e moved the
  // version into the privacyConsent record.)
  await keepingSettings(async () => {
    const line = readSettingsFile().split('\n').find((l) => l.startsWith('privacyConsent '))!;
    const rec = JSON.parse(line.replace(/^privacyConsent = /, ''));
    const withVersion = (v: number) => {
      dropSettings('privacyConsent');
      inPlayer('sh', '-c', `printf 'privacyConsent = %s\\n' '${JSON.stringify({ ...rec, version: v })}' >> ${SETTINGS}`);
    };
    withVersion(rec.version - 1);
    expect(await sentToSetup(request), 'an older consent version was accepted').toBe(true);
    withVersion(rec.version + 4);
    expect(await sentToSetup(request), 'a newer consent version was treated as missing').toBe(false);
    dropSettings('privacyConsent');
    expect(await sentToSetup(request), 'no consent record at all was accepted').toBe(true);
  });
});

test('finishing the wizard with its defaults records every setting it showed', async () => {
  // Regression: 36e18e02b.  Only settings whose control fired onChange were
  // saved, so whatever the user looked at and accepted -- the time zone above
  // all, which nothing else writes -- was never recorded.  The setup project
  // finished the wizard touching only the jurisdiction and the UI password.
  const file = readSettingsFile();
  for (const key of ['TimeZone', 'Locale', 'WifiRegulatoryDomain', 'HostName', 'fppMode', 'uiLevel',
    'LegalJurisdiction', 'statsPublish', 'ShareCrashData', 'FetchVendorLogos', 'SendVendorSerial']) {
    expect(file, `${key} was not written by Finish`).toMatch(new RegExp(`^${key} = `, 'm'));
  }
});

test('a backup restored in the setup wizard says when it leaves a privacy answer missing', async ({ request }) => {
  // Regression: 926cfb097 (and 06d559fb9, which widened it to every privacy
  // answer).  A restore through the wizard sent the browser to index.php,
  // whose gate sent it straight back, with no word of why; the reply now says
  // what is still missing (NeedsSetup), so the page can stay in setup.
  const dl = await request.post('/backup.php', { form: { btnDownloadConfig: '1', backuparea: 'settings' } });
  expect(dl.ok()).toBe(true);
  const full = JSON.parse((await dl.body()).toString());
  const restore = async (backup: object) => {
    const r = await request.post('/initialSetup.php', {
      multipart: { restoreFile: { name: 'fpp-tests-privacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) } },
    });
    const body = await r.text();
    expect(r.ok(), body).toBe(true);
    return JSON.parse(body);
  };
  await keepingSettings(async () => {
    try {
      // A player that has not finished setup, with no jurisdiction recorded
      dropSettings('initialSetup-02', 'LegalJurisdiction');
      const stripped = JSON.parse(JSON.stringify(full));
      for (const s of stripped.settings.system_settings) delete s.LegalJurisdiction;
      const missing = await restore(stripped);
      expect(missing.Status, JSON.stringify(missing)).toBe('OK');
      expect(missing.NeedsSetup, JSON.stringify(missing)).toBe(true);
      expect(missing.Message).toContain('LegalJurisdiction');

      // The control: a backup that answers everything.
      dropSettings('initialSetup-02');
      const whole = await restore(full);
      expect(whole.Status, JSON.stringify(whole)).toBe('OK');
      expect(whole.NeedsSetup, JSON.stringify(whole)).toBe(false);
    } finally {
      inPlayer('rm', '-f', '/home/fpp/media/config/backups/fpp-tests-privacy.json');
    }
  });
});
