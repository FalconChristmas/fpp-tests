import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The detail line under a MultiSync row's platform: drawn first from the
// model in fppd's systems list, then from the remote's own status answer
// (advancedView) once it is polled.  Both are answered by the test.

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi', model: 'fpp-tests model from the list',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

function status(subPlatform: string, variant: string) {
  return {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', SubPlatform: subPlatform, Variant: variant, Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', Utilization: { CPU: 1, Memory: 2 },
    },
  };
}

async function openMultisync(page: Page, statuses: Record<string, unknown>) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('192.168.0.13', 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
    system('192.168.0.21', 'fpptests-full', 'M1-fpptests-full'),
    system('192.168.0.22', 'fpptests-short', 'M1-fpptests-short'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: statuses }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

const detail = (page: Page, host: string) =>
  page.locator('#fppSystems tr.systemRow', { hasText: host }).locator('small[id$="_variant"]');

test('the platform detail shows the remote\'s SubPlatform, or its Variant when it has none', async ({ page }) => {
  // Feature: 942f0640e (#2614).  The status poll replaced the detail with
  // the short Variant ("PiZero 2") even when the remote also sent the full
  // model, SubPlatform ("Raspberry Pi Zero 2 W Rev 1.0").
  await openMultisync(page, {
    '192.168.0.21': status('Raspberry Pi Zero 2 W Rev 1.0', 'PiZero 2'),
    '192.168.0.22': status('', 'Pi 4'),
  });
  // The control: the second remote's poll was drawn (the list said otherwise).
  await expect(detail(page, 'fpptests-short')).toHaveText('Pi 4', { timeout: 15_000 });
  await expect(detail(page, 'fpptests-full')).toHaveText('Raspberry Pi Zero 2 W Rev 1.0');
});
