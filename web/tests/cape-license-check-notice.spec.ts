import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The browser half of the cape licence notice (capeLicense.inc, cape-info.php,
// POST api/cape/licenseCheck).  A cape whose signature verifies but is not
// bound to hardware is marked `licenseCheck` in cape-info.json; Cape Info then
// requests the vendor's URL once the page has loaded and reports whether that
// reached the vendor.  Once delivered it is quiet for 7 days; a failure is
// retried after 24 hours; a different cape is a new detection.  The vendor
// host is answered (or refused) by the test; the state file is removed after.

test.skip(!container, 'puts a cape-info.json in the run-web.sh container');
// On a player, cape detection adds the vendor's host to the CSP connect-src
// (ManageApacheContentPolicy.sh); the stand-in cape here never went through
// detection, so the policy is bypassed instead of rewriting Apache's.
test.use({ bypassCSP: true });

const CAPE_INFO = '/home/fpp/media/tmp/cape-info.json';
const STATE = '/home/fpp/media/config/cape_license_state.json';
const VENDOR = 'https://vendor.fpp-tests.invalid';
const HOUR = 3600;

function cape(extra: Record<string, unknown> = {}, vendor: Record<string, unknown> = { licenseCheckUrl: `${VENDOR}/lc` }) {
  inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify({
    id: 'FppTestsLic', name: 'fpp-tests licensed cape', version: '1.0', serialNumber: 'SNLIC1', cs: 'abc123',
    verifiedKeyId: 'fpptestskey', licenseCheck: true, provides: [], vendor: { name: 'fpp-tests Vendor', ...vendor }, ...extra,
  }), CAPE_INFO);
}
const now = () => Math.floor(Date.now() / 1000);
const identity = (id = 'FppTestsLic', sn = 'SNLIC1') => `${id}/${sn}/abc123/fpptestskey/`;
const state = () => {
  const s = inPlayer('sh', '-c', `cat ${STATE} 2>/dev/null || true`).trim();
  return s ? JSON.parse(s) : null;
};
const setState = (s: object) => inPlayer('sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', JSON.stringify(s), STATE);

test.afterEach(() => {
  inPlayer('rm', '-f', CAPE_INFO, STATE, '/home/fpp/media/tmp/eepromVendors.json');
});

// Opens Cape Info; the vendor host answers when `reach` is true, fails otherwise.
async function visit(page: Page, reach: boolean) {
  const vendor: string[] = [];
  const reports: any[] = [];
  await page.route(`${VENDOR}/**`, (r) => {
    // The vendor logo on the page is fetched too; only the notice has lc=1.
    if (new URL(r.request().url()).searchParams.get('lc') === '1') vendor.push(r.request().url());
    return reach ? r.fulfill({ body: '' }) : r.abort('internetdisconnected');
  });
  await page.route('**/api/cape/eeprom/vendors**', (r) => r.fulfill({ json: { index: [] } }));
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/cape/licenseCheck') reports.push(JSON.parse(r.postData() || '{}'));
  });
  const done = page.waitForResponse((r) => r.url().endsWith('/api/cape/licenseCheck'), { timeout: 10_000 }).catch(() => null);
  await page.goto('/cape-info.php');
  await page.waitForLoadState('load');
  await done;
  await page.waitForTimeout(500);
  return { vendor, reports };
}

test('a delivered notice names the cape, is recorded, and is not sent again within the week', async ({ page }) => {
  cape();
  const first = await visit(page, true);
  expect(first.vendor).toHaveLength(1);
  const u = new URL(first.vendor[0]);
  expect(u.origin + u.pathname).toBe(`${VENDOR}/lc`);
  expect(Object.fromEntries(u.searchParams)).toEqual({ lc: '1', id: 'FppTestsLic', sn: 'SNLIC1', cs: 'abc123', key: 'fpptestskey' });
  expect(first.reports).toEqual([{ delivered: true }]);
  const s = state();
  expect(s).toMatchObject({ cape: identity(), source: 'browser' });
  expect(Math.abs(s.lastSuccess - now())).toBeLessThan(60);

  const again = await visit(page, true);
  expect(again.vendor).toEqual([]);
  expect(again.reports).toEqual([]);

  // Eight days on, it is sent again.
  setState({ ...s, lastSuccess: now() - 8 * 24 * HOUR, lastAttempt: now() - 8 * 24 * HOUR });
  expect((await visit(page, true)).vendor).toHaveLength(1);
});

test('an undelivered notice is retried after a day, not on every visit', async ({ page }) => {
  cape();
  const first = await visit(page, false);
  expect(first.vendor).toHaveLength(1);
  expect(first.reports).toEqual([{ delivered: false }]);
  expect(state()).not.toHaveProperty('lastSuccess');
  expect((await visit(page, false)).vendor).toEqual([]);

  setState({ ...state(), lastAttempt: now() - 25 * HOUR });
  const later = await visit(page, true);
  expect(later.vendor).toHaveLength(1);
  expect(later.reports).toEqual([{ delivered: true }]);
});

test('the logo host stands in for a vendor with no licence URL; none at all, or not http, sends nothing', async ({ page, request }) => {
  cape({}, { image: `${VENDOR}/logo.png?size=1` });
  const logo = await visit(page, true);
  expect(logo.vendor).toHaveLength(1);
  expect(logo.vendor[0]).toMatch(new RegExp(`^${VENDOR}/logo\\.png\\?size=1&lc=1&`));

  inPlayer('rm', '-f', STATE);
  cape({}, { url: 'javascript:alert(1)' });
  expect((await visit(page, true)).vendor).toEqual([]);

  // A cape without the marker: nothing is sent, and the route refuses to record.
  inPlayer('rm', '-f', STATE);
  cape({ licenseCheck: undefined });
  expect((await visit(page, true)).vendor).toEqual([]);
  const r = await request.post('/api/cape/licenseCheck', { data: { delivered: true } });
  expect(r.status()).toBe(404);
  expect(state()).toBeNull();
});

test("a new cape whose notice failed is retried after a day, whatever the last cape's delivery", async ({ page }) => {
  test.fail(true, "capeLicenseRecord keeps the previous cape's lastSuccess, so the new cape waits out that week (FUTURE.md)");
  // The previous cape was delivered an hour ago.
  setState({ cape: identity('FppTestsOld', 'SNOLD'), lastAttempt: now() - HOUR, lastSuccess: now() - HOUR, source: 'browser' });
  cape();
  const first = await visit(page, false);
  expect(first.vendor, 'a different cape is a new detection').toHaveLength(1);
  expect(first.reports).toEqual([{ delivered: false }]);

  setState({ ...state(), lastAttempt: now() - 25 * HOUR });
  expect((await visit(page, true)).vendor, 'the new cape was never delivered').toHaveLength(1);
});

test('a weekly notice that fails is retried after a day, not on every visit', async ({ page }) => {
  test.fail(true, 'the old lastSuccess is kept, so the 24-hour retry check is skipped and every visit sends again (FUTURE.md)');
  setState({ cape: identity(), lastAttempt: now() - 8 * 24 * HOUR, lastSuccess: now() - 8 * 24 * HOUR, source: 'browser' });
  cape();
  const first = await visit(page, false);
  expect(first.vendor).toHaveLength(1);
  expect(first.reports).toEqual([{ delivered: false }]);
  expect((await visit(page, false)).vendor, 'sent again on the next visit').toEqual([]);
});
