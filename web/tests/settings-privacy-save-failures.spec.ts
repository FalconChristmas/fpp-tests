import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Settings > Privacy (settings-privacy.php) when a save does not go through:
// a setting's PUT failing, or the consent record's POST failing.  The page
// saves each changed setting, then stamps the consent for what changed
// (api/privacy/consent).  privacy-table.spec.ts has the saves that work.
// The failures are answered here; what did save is in the real settings file.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

type Consent = { via: string; settings: Record<string, string> };

async function open(page: Page, failPut: Set<string>, failConsent: { on: boolean }) {
  const consents: Consent[] = [];
  let finished = 0;
  await page.route((u) => u.pathname.startsWith('/api/settings/'), (r) => {
    const k = new URL(r.request().url()).pathname.slice(14);
    if (r.request().method() === 'PUT' && failPut.has(k)) return r.fulfill({ status: 500, body: 'fpp-tests' });
    return r.fallback();
  });
  await page.route('**/api/privacy/consent', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    consents.push(JSON.parse(r.request().postData() || '{}'));
    return failConsent.on ? r.fulfill({ status: 500, body: 'fpp-tests' }) : r.fallback();
  });
  page.on('requestfinished', (r) => {
    if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/settings/')) finished++;
  });
  page.on('requestfailed', (r) => {
    if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/settings/')) finished++;
  });
  await page.goto('/settings.php#settings-privacy');
  await expect(page.locator('#settings-privacy #privacyTable')).toBeVisible();
  return { consents, settled: (n: number) => expect.poll(() => finished, { timeout: 30_000 }).toBe(n) };
}
const saved = (k: string) => inPlayer('sh', '-c', `grep -E '^${k} ' /home/fpp/media/settings || true`).trim();
const status = (page: Page) => page.locator('#privacySaveStatus');

test('a failed save says so and stamps no consent, and the next change sends it again', async ({ page }) => {
  await keepingSettings(async () => {
    setSettingInFile('ShareCrashData', '0');
    const failPut = new Set(['ShareCrashData']);
    const { consents, settled } = await open(page, failPut, { on: false });
    await page.check('#settings-privacy input[name="privacy_crash"][value="allow"]');
    await settled(1);
    await expect(status(page)).toHaveText('Could not save ShareCrashData.');
    await page.waitForTimeout(500);
    expect(consents).toEqual([]);
    expect(saved('ShareCrashData')).toBe('ShareCrashData = "0"');

    // It still counts as changed: once the save works, the next touch sends it.
    failPut.clear();
    await page.check('#settings-privacy input[name="privacy_crash-settings"][value="allow"]');
    await settled(2);
    await expect(status(page)).toHaveText('Saved.');
    expect(saved('ShareCrashData')).toBe('ShareCrashData = "2"');
    expect(consents.map((c) => c.settings)).toEqual([{ ShareCrashData: '2' }]);
  });
});

test('a consent record that cannot be written is reported, the setting still saved', async ({ page }) => {
  await keepingSettings(async () => {
    setSettingInFile('ShareCrashData', '0');
    const { consents, settled } = await open(page, new Set(), { on: true });
    await page.check('#settings-privacy input[name="privacy_crash"][value="allow"]');
    await settled(1);
    await expect(status(page)).toHaveText('Saved, but the consent record could not be updated.');
    expect(consents.map((c) => [c.via, c.settings])).toEqual([['settings', { ShareCrashData: '1' }]]);
    expect(saved('ShareCrashData')).toBe('ShareCrashData = "1"');
  });
});

test('when one of two saves fails, the one that saved still gets its consent stamped', async ({ page }) => {
  // Denying the cape logo also denies the serial.  FetchVendorLogos saves,
  // SendVendorSerial does not: the page records no consent at all, and
  // marks FetchVendorLogos as saved, so a later retry stamps only the serial.
  test.fail(true, 'recordConsent runs only when every PUT succeeded, so a withdrawal that did save is never recorded (FUTURE.md)');
  await keepingSettings(async () => {
    setSettingInFile('FetchVendorLogos', '1');
    setSettingInFile('SendVendorSerial', '1');
    setSettingInFile('ShareCrashData', '0');
    const failPut = new Set(['SendVendorSerial']);
    const { consents, settled } = await open(page, failPut, { on: false });
    await page.check('#settings-privacy input[name="privacy_logos"][value="deny"]');
    await settled(2);
    await expect(status(page)).toHaveText('Could not save SendVendorSerial.');
    expect(saved('FetchVendorLogos')).toBe('FetchVendorLogos = "0"');

    // The serial's save is retried by the next change and works.
    failPut.clear();
    await page.check('#settings-privacy input[name="privacy_crash"][value="allow"]');
    await settled(4);
    await expect(status(page)).toHaveText('Saved.');
    expect(saved('SendVendorSerial')).toBe('SendVendorSerial = "0"');
    const stamped = Object.assign({}, ...consents.map((c) => c.settings));
    expect(stamped, 'the logo withdrawal that saved has no consent record').toHaveProperty('FetchVendorLogos', '0');
  });
});
