import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The MultiSync systems table is built from api/fppd/multiSyncSystems; the
// proxy list (api/proxies) only decorates its links.  Both are answered, or
// failed, by the test.

const SYSTEMS = {
  systems: [{
    address: '192.168.0.13', hostname: 'FPPTESTLOCAL', local: 1, fppMode: 2, fppModeString: 'player',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
    uuid: 'M1-fpptests-local', channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  }, {
    address: '192.168.0.21', hostname: 'FPPTESTREMOTE', local: 0, fppMode: 2, fppModeString: 'player',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
    uuid: 'M1-fpptests-remote', channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  }],
};

async function common(page: Page) {
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
}

test('a failed proxy list does not hold back the systems table', async ({ page }) => {
  // Regression: cb64941ed.  The table was built from inside the proxy
  // request's .then(), with no .catch(): when api/proxies failed the page sat
  // on "Loading system list from fppd." for good.
  await common(page);
  await page.route('**/api/proxies', (route) => route.abort());
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
});

test('a failed systems list says so and can be retried', async ({ page }) => {
  // Regression: cb64941ed.  A failed api/fppd/multiSyncSystems left the
  // "Loading..." row up with nothing said; now the row says the list could
  // not be loaded, and its Retry link loads it.
  await common(page);
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  let fail = true;
  await page.route('**/api/fppd/multiSyncSystems', (route) =>
    fail ? route.fulfill({ status: 500, body: 'error' }) : route.fulfill({ json: SYSTEMS }));
  await page.goto('/multisync.php');
  const body = page.locator('#fppSystems');
  await expect(body).toContainText('Could not load the system list', { timeout: 15_000 });
  fail = false;
  await body.locator('a', { hasText: 'Retry' }).click();
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
});
