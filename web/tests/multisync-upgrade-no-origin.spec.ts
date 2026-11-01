import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Upgrading the checked systems from the MultiSync page: a remote whose git
// information the page does not have (so it does not know where it updates
// from) is skipped with a message, and the rest are sent.  The systems list,
// the status batch and the job runner are answered by the test.

const LOCAL = '192.168.0.13';
const KNOWN = '192.168.0.21';
const BLIND = '192.168.0.22';

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
    system(KNOWN, 'fpptests-known', 'M1-fpptests-known'),
    system(BLIND, 'fpptests-blind', 'M1-fpptests-blind'),
  ],
};

// KNOWN reports its git versions; BLIND answers without them.
const STATUS = {
  [KNOWN]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: {
      Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
      LocalGitVersion: 'aaa1111', RemoteGitVersion: 'bbb2222', UpgradeSource: 'github.com',
      Utilization: { CPU: 12, Memory: 34 },
    },
  },
  [BLIND]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Platform: 'Raspberry Pi', Utilization: { CPU: 12, Memory: 34 } },
  },
};

async function openMultisync(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: STATUS }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(3, { timeout: 15_000 });
}

test('a checked remote with no git origin known is skipped with a message, not sent', async ({ page }) => {
  // Regression: 04b614609.  The origin cell was read without checking it
  // existed, so upgrading a remote whose git information had not come in
  // died on the missing cell.  It is now skipped with a message, and not
  // sent as an upgrade from an unknown origin.
  const jobs: any[] = [];
  await page.route('**/streamRemoteJobs.php', (route) => {
    const body = route.request().postDataJSON();
    jobs.push(...body.jobs);
    const lines = body.jobs.map((j: any) => JSON.stringify({ id: j.id, done: true, ok: true })).join('\n') + '\n' +
      JSON.stringify({ end: true }) + '\n';
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines });
  });
  page.on('dialog', (d) => d.accept());
  await openMultisync(page);
  const known = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-known' });
  const blind = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-blind' });
  await expect(known).toContainText('aaa1111', { timeout: 15_000 });
  await known.locator('input.remoteCheckbox').check();
  await blind.locator('input.remoteCheckbox').check();
  await page.evaluate('upgradeSelectedSystems()');
  await expect(page.locator('.jGrowl-message', { hasText: `Invalid Origin for ${BLIND}. Skipping` })).toBeVisible();
  await expect.poll(() => jobs.length, { timeout: 10_000 }).toBe(1);
  expect(jobs.map((j) => j.ip)).toEqual([KNOWN]);
});
