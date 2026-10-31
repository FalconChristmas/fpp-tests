import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The MultiSync page's Mode filter, over a
// systems list the test supplies (as multisync-list-loading.spec.ts does).

const system = (address: string, hostname: string, extra: object = {}) => ({
  address, hostname, local: 0, fppMode: 2, fppModeString: 'player',
  typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 1000,
  uuid: `M1-${hostname}`, channelRanges: '', multiSyncCapable: 1, multisync: false,
  lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '', ...extra,
});

const SYSTEMS = {
  systems: [
    system('192.168.0.13', 'FPPTESTLOCAL', { local: 1 }),
    system('192.168.0.21', 'FPPPLAIN'),
    system('192.168.0.22', 'FPPMULTISYNC', { multisync: true }),
  ],
};

async function load(page: Page) {
  const status = (mode: number, multisync: boolean) => ({ mode, multisync, status_name: 'idle', status: 0, fppd: 'running' });
  await page.route('**/api/system/status?**', (route) => route.fulfill({
    json: { '192.168.0.21': status(2, false), '192.168.0.22': status(2, true) } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

test('the Mode filter has a Multisync entry that keeps only the players sending multisync', async ({ page }) => {
  // Feature: 648f8b383.  "Player w/ Multisync" had no entry of its own.
  await load(page);
  const select = page.locator('select.bootstrap-table-filter-control-mode');
  await expect(select).toBeAttached();
  await select.selectOption({ label: 'Multisync' });
  // all three rows are "Player"; only one is a player with multisync
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(1);
  await expect(page.locator('#fppSystems tr.systemRow')).toContainText('FPPMULTISYNC');
});
