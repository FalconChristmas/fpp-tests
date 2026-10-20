import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { dropSettings, keepingSettings, setSettingInFile } from './privacy-helpers';

// The privacy table: the setup wizard's privacy step and Settings > Privacy
// render the same rows (privacyTable.inc, js/fpp-privacy-table.js).  Whether
// the rows start answered depends on the declared jurisdiction.  The setup
// project has finished the wizard (US) before this runs; these tests open it
// again with the answers taken out of the settings file, and never Finish.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CAPEDETECT = '/opt/fpp/src/fppcapedetect';
const ANSWERS = ['LegalJurisdiction', 'statsPublish', 'ShareCrashData', 'FetchVendorLogos', 'SendVendorSerial', 'privacyConsent'];
const ROWS = ['stats', 'logos', 'serial', 'crash', 'crash-settings', 'crash-config'];

// A player with no cape support built (no fppcapedetect), as on most
// platforms but not this container.
async function withoutCapeDetect<T>(fn: () => Promise<T>): Promise<T> {
  inPlayer('mv', CAPEDETECT, `${CAPEDETECT}.fpp-tests`);
  try {
    return await fn();
  } finally {
    inPlayer('mv', `${CAPEDETECT}.fpp-tests`, CAPEDETECT);
  }
}

async function toPrivacyStep(page: Page, jurisdiction: string) {
  await page.goto('/initialSetup.php');
  await page.selectOption('#LegalJurisdiction', jurisdiction);
  for (const step of [2, 3]) {
    await page.click('#setupNextBtn');
    await expect(page.locator(`.setupStep[data-step="${step}"]`)).toBeVisible({ timeout: 60_000 });
  }
}

async function answer(page: Page, row: string) {
  return page.evaluate((r) => (window as any).fppPrivacyTable.get(r), row);
}

test('with no cape support, a jurisdiction without prior opt-in starts the privacy step answered', async ({ page, request }) => {
  // Regression: 53bd2dd4d.  The wizard learned whether the jurisdiction needs
  // prior opt-in only from api/cape/defaults, which answered null where there
  // is no fppcapedetect; it stayed on the cautious guess from the time zone,
  // so a US player's privacy step came up unanswered and would not move on.
  await keepingSettings(() => withoutCapeDetect(async () => {
    dropSettings(...ANSWERS);  // TimeZone stays Europe/London: the guess is UK, strict
    const d = await (await request.get('/api/cape/defaults?regime=US')).json();
    expect(d.priorOptIn, 'no answer without fppcapedetect').toBe(false);

    await toPrivacyStep(page, 'US');
    for (const row of ROWS) expect(await answer(page, row), `${row} starts unanswered under US`).not.toBe('');
    await page.click('#setupNextBtn');
    await expect(page.locator('.setupStep[data-step="4"]'), 'the privacy step would not move on').toBeVisible();

    // The control: where prior opt-in is required, the rows (bar the crash
    // stack, which rests on legitimate interests) start unanswered and the
    // step will not move on.
    await toPrivacyStep(page, 'EU');
    expect(await answer(page, 'crash')).toBe('allow');
    for (const row of ['stats', 'logos', 'crash-settings']) expect(await answer(page, row), row).toBe('');
    await page.click('#setupNextBtn');
    await expect(page.locator('#privacyRequiredNote')).toBeVisible();
    await expect(page.locator('.setupStep[data-step="3"]')).toBeVisible();
  }));
});

test('a player that cannot tell where it is takes the strict answer, in both halves', async ({ request }) => {
  // Regression: 0106041d9.  With no jurisdiction recorded and a time zone
  // that names no region, the C++ half (fppcapedetect, with the cape) and the
  // PHP half (without one) both fell through to "no restriction" -- before
  // anyone had been asked anything.
  await keepingSettings(async () => {
    dropSettings('LegalJurisdiction');
    setSettingInFile('TimeZone', 'Asia/Tokyo');
    const withCape = await (await request.get('/api/cape/defaults')).json();
    expect(withCape.priorOptIn, 'fppcapedetect: unknown is not unrestricted').toBe(true);
    await withoutCapeDetect(async () => {
      const without = await (await request.get('/api/cape/defaults')).json();
      expect(without.priorOptIn, 'PHP: unknown is not unrestricted').toBe(true);
    });
  });
});

test('the crash rows are a ladder, and their four states are ShareCrashData 0 to 3', async ({ page }) => {
  // Feature: 0d868434a.  Allowing a row allows its parents; denying one denies
  // and locks its descendants; deny-all is 0 (keep locally), never -1; and an
  // unanswered statsPublish ("Banner") resolves to an answer where no prior
  // opt-in is needed.
  await keepingSettings(() => withoutCapeDetect(async () => {
    dropSettings(...ANSWERS);
    await toPrivacyStep(page, 'US');
    const collect = () => page.evaluate(() => (window as any).fppPrivacyTable.collect());
    const click = (row: string, v: string) => page.check(`input[name="privacy_${row}"][value="${v}"]`);
    expect((await collect()).statsPublish).toBe('Enabled');

    await click('crash', 'deny');
    for (const row of ['crash-settings', 'crash-config']) {
      expect(await answer(page, row)).toBe('deny');
      await expect(page.locator(`input[name="privacy_${row}"][value="allow"]`), `${row} is not locked`).toBeDisabled();
    }
    expect((await collect()).ShareCrashData).toBe('0');

    await click('crash', 'allow');
    await click('crash-settings', 'deny');
    expect((await collect()).ShareCrashData).toBe('1');
    await click('crash-settings', 'allow');
    await click('crash-config', 'deny');
    expect((await collect()).ShareCrashData).toBe('2');

    await click('crash-config', 'allow');
    expect((await collect()).ShareCrashData).toBe('3');

    await click('logos', 'deny');
    expect(await answer(page, 'serial'), 'the serial rides on the logo request').toBe('deny');
    expect(await collect()).toMatchObject({ FetchVendorLogos: '0', SendVendorSerial: '0' });

    // Where the rows start unanswered, allowing the deepest one allows the
    // rows above it.
    await toPrivacyStep(page, 'EU');
    expect(await answer(page, 'crash-settings')).toBe('');
    await click('crash-config', 'allow');
    expect(await answer(page, 'crash-settings'), 'allowing a row did not allow its parent').toBe('allow');
    expect((await collect()).ShareCrashData).toBe('3');
  }));
});

test('Settings > Privacy saves only what changed, once, and records the consent', async ({ page }) => {
  // Feature: 1f23bb132.  The settings tab renders the wizard's table and
  // saves as it goes: nothing on load, one PUT per changed setting, and
  // denying the cape logo also denies the serial that rides on it.  (Opening
  // the tab twice does not initialise the table twice here, so the guard
  // against a doubled change handler is not exercised.)
  await keepingSettings(async () => {
    setSettingInFile('ShareCrashData', '0');
    setSettingInFile('FetchVendorLogos', '1');
    setSettingInFile('SendVendorSerial', '1');
    const puts: string[] = [];
    const consents: any[] = [];
    let saved = 0;
    // Each save makes a settings backup and can take seconds; the page
    // compares a change against the values whose save has finished, so a
    // click before the last save is done re-sends that setting too.  Wait for
    // every save to finish before the next click, as a person would.
    const settled = (n: number) => expect.poll(() => saved, { timeout: 30_000 }).toBe(n);
    page.on('requestfinished', (r) => {
      if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/settings/')) saved++;
    });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (r.method() === 'PUT' && u.pathname.startsWith('/api/settings/')) puts.push(`${u.pathname.slice(14)}=${r.postData()}`);
      if (r.method() === 'POST' && u.pathname === '/api/privacy/consent') consents.push(JSON.parse(r.postData() || '{}'));
    });
    await page.goto('/settings.php#settings-privacy');
    await expect(page.locator('#settings-privacy #privacyTable')).toBeVisible();
    // Opened a second time: the fragment initialises again.
    await page.click('#settings-ui-tab').catch(() => {});
    await page.click('#settings-privacy-tab');
    await expect(page.locator('#settings-privacy #privacyTable')).toBeVisible();
    await page.waitForTimeout(500);
    expect(puts, 'opening the page saved settings').toEqual([]);

    await page.check('#settings-privacy input[name="privacy_crash"][value="allow"]');
    await settled(1);
    await page.waitForTimeout(500);
    expect(puts, 'one change, one save').toEqual(['ShareCrashData=1']);
    await page.check('#settings-privacy input[name="privacy_crash-settings"][value="allow"]');
    await settled(2);
    await page.check('#settings-privacy input[name="privacy_crash-config"][value="allow"]');
    await settled(3);
    expect(puts).toEqual(['ShareCrashData=1', 'ShareCrashData=2', 'ShareCrashData=3']);

    await page.check('#settings-privacy input[name="privacy_logos"][value="deny"]');
    await settled(5);
    await page.waitForTimeout(500);
    expect(puts.slice(3).sort()).toEqual(['FetchVendorLogos=0', 'SendVendorSerial=0']);
    expect(inPlayer('grep', '-E', '^(ShareCrashData|FetchVendorLogos|SendVendorSerial) ', '/home/fpp/media/settings').split('\n').filter(Boolean).sort())
      .toEqual(['FetchVendorLogos = "0"', 'SendVendorSerial = "0"', 'ShareCrashData = "3"']);
    await expect.poll(() => consents.length).toBe(4);
    expect(consents.map((c) => [c.via, Object.keys(c.settings).sort()])).toEqual([
      ['settings', ['ShareCrashData']], ['settings', ['ShareCrashData']], ['settings', ['ShareCrashData']],
      ['settings', ['FetchVendorLogos', 'SendVendorSerial']]]);
  });
});
