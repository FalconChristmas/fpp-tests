import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { answerUpdateCheck } from './standin-http';

// The MultiSync page marks a system whose channel inputs or outputs are on
// with an icon by its mode.  The flags are in a player's status
// (channelInputsEnabled / channelOutputsEnabled, from fppd); this player's
// own are read for real, and a remote's status is answered by the test.

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.31';

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '1-1020', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

function remoteStatus(flags: Record<string, boolean>) {
  return {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', UpgradeSource: 'github.com',
      Utilization: { CPU: 12, Memory: 34 },
    },
    ...flags,
  };
}

async function remoteRow(page: Page, flags: Record<string, boolean>) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await answerUpdateCheck(page);
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({
    json: { systems: [system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(REMOTE, 'fpptests-io', 'M1-fpptests-io')] },
  }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [REMOTE]: remoteStatus(flags) } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  // Older-system probing (no flags) fetches the remote's configs: none here.
  await page.route('**/api/channel/**ip=**', (route) => route.fulfill({ json: { status: 'OK' } }));
  await page.goto('/multisync.php');
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-io' });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText('Remote', { timeout: 15_000 });
  return row;
}

test("this player's status carries its channel input and output flags", async ({ request }) => {
  // Feature: 13ff67884, the sending end: fppd's status has the two flags,
  // and the page's status reply passes them on.
  const fppd = await (await request.get('/api/fppd/status')).json();
  expect(typeof fppd.channelInputsEnabled).toBe('boolean');
  expect(typeof fppd.channelOutputsEnabled).toBe('boolean');
  const php = await (await request.get('/api/system/status')).json();
  expect(php.channelInputsEnabled).toBe(fppd.channelInputsEnabled);
  expect(php.channelOutputsEnabled).toBe(fppd.channelOutputsEnabled);
});

test('a remote with channel inputs and outputs on gets both icons', async ({ page }) => {
  // Feature: 13ff67884 (#2100).
  const row = await remoteRow(page, { channelInputsEnabled: true, channelOutputsEnabled: true });
  await expect(row.locator('.channel-io-icon-input')).toHaveCount(1, { timeout: 15_000 });
  await expect(row.locator('.channel-io-icon-output')).toHaveCount(1);
});

test('a remote with both off gets neither', async ({ page }) => {
  // The control for the test above.
  const row = await remoteRow(page, { channelInputsEnabled: false, channelOutputsEnabled: false });
  await page.waitForTimeout(2000);
  await expect(row.locator('.channel-io-icons')).toHaveCount(0);
});
