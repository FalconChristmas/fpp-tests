import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// A player asked to hide external URLs (a kiosk browser, or a proxy that sends
// "Hide-External-Links: true") links no other device from the MultiSync page:
// not the host name, not the address, not the commit.  Without the request the
// same row links all three.

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const SYSTEMS = {
  systems: [
    system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
    system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote'),
  ],
};

const REMOTE_STATUS = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  advancedView: {
    Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'bbb2222', UpgradeSource: 'github.com',
    IPs: [REMOTE], Utilization: { CPU: 12, Memory: 34 },
  },
};

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [REMOTE]: REMOTE_STATUS } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  // The commit is drawn once the remote's status is in.
  await expect(row).toContainText('aaa1111', { timeout: 15_000 });
  return row;
}

test('a remote\'s host name, address and commit are links to it', async ({ page }) => {
  // The control for the next test: the row has links to take away.
  const row = await openMultisync(page);
  await expect(row.locator(`a[href*="${REMOTE}"]`).first()).toBeVisible();
  await expect(row.locator('a', { hasText: 'fpptests-remote' })).toHaveCount(1);
  await expect(row.locator('a', { hasText: 'aaa1111' })).toHaveCount(1);
  await expect(row.locator('a', { hasText: REMOTE })).not.toHaveCount(0);
});

test('with external URLs hidden, a remote\'s host name, address and commit are plain text', async ({ page }) => {
  // Regression: bd9c4f9f5.  The MultiSync page linked the host name, the
  // address and the commit of every device whether or not the player had been
  // asked to hide external URLs.
  await page.setExtraHTTPHeaders({ 'Hide-External-Links': 'true' });
  const row = await openMultisync(page);
  await expect(row).toContainText('fpptests-remote');
  await expect(row).toContainText(REMOTE);
  await expect(row.locator('a[href*="http"], a[href*="proxy/"]'), 'a link to the remote is left').toHaveCount(0);
  await expect(row.locator('a', { hasText: 'fpptests-remote' })).toHaveCount(0);
  await expect(row.locator('a', { hasText: 'aaa1111' })).toHaveCount(0);
  await expect(row.locator('a', { hasText: REMOTE })).toHaveCount(0);
});
