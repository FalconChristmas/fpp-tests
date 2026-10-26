import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { answerUpdateCheck } from './standin-http';

// The MultiSync page makes one row per device.  fppd lists a device once
// per address it has heard from it, and the entries can disagree in what
// they say (a stale entry from before an upgrade or a mode change); they
// share the device's UUID.  The systems list is answered by the test.

const LOCAL = '192.168.0.13';

function system(address: string, hostname: string, uuid: string, extra: Record<string, unknown> = {}) {
  return {
    address, hostname, local: 0, fppMode: 8, fppModeString: 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '1-1020', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
    ...extra,
  };
}

async function openMultisync(page: Page, systems: object[]) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await answerUpdateCheck(page);
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', { local: 1, fppMode: 2, fppModeString: 'player' }), ...systems] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow', { hasText: 'FPPTESTLOCAL' })).toHaveCount(1, { timeout: 15_000 });
}

test('entries with one UUID and different names, modes and versions make one row', async ({ page }) => {
  // Regression: 9d2d7d67d.  Rows were keyed on what an entry said about
  // itself (hostname, version, mode, channel ranges), so a device listed at
  // two addresses whose entries disagreed (one from before a rename and an
  // upgrade) got two rows.
  await openMultisync(page, [
    system('192.168.0.40', 'fpptests-dual', 'M1-fpptests-dual'),
    system('192.168.0.41', 'fpptests-renamed', 'M1-fpptests-dual', {
      fppMode: 2, fppModeString: 'player', version: '9.5', majorVersion: 9, minorVersion: 5,
    }),
    system('192.168.0.50', 'fpptests-other', 'M1-fpptests-other'),
  ]);
  const rows = page.locator('#fppSystems tr.systemRow');
  // The control: the other device has its own row.
  await expect(rows.filter({ hasText: 'fpptests-other' })).toHaveCount(1);
  const dual = rows.filter({ hasText: '192.168.0.40' });
  await expect(dual).toHaveCount(1);
  await expect(dual).toContainText('192.168.0.40');
  await expect(dual).toContainText('192.168.0.41');
  await expect(rows).toHaveCount(3);
});
