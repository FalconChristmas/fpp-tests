import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// Upgrading a remote from the MultiSync page: the job goes to the address the
// remote was listed at, and, where this player is reached by name rather
// than by address, the remote's host name goes with it as the fallback (a
// browser on a name-based setup reaches the remotes by name too).  The
// systems list, the status batch and the job runner are answered by the test.

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
    // A UUID, as every FPP 10 player has: its row is keyed by that, not by
    // its address.
    system(REMOTE, 'fpptests-remote', 'M1-fpptests-remote'),
  ],
};

const REMOTE_STATUS = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  advancedView: {
    Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'bbb2222', UpgradeSource: 'github.com',
    Utilization: { CPU: 12, Memory: 34 },
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
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
}

test('an upgrade goes to the remote\'s address, with its host name as the fallback', async ({ page }) => {
  // Regression: e61469d0d.  The host name was read from a DOM span looked up
  // by the row's id, but rows are keyed by UUID and the span by address, so
  // it was never found: the job was sent to "undefined" ("undefined is not
  // a valid IP"); since the batch runner took the address from the row, the
  // host name was dropped instead.
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
  // This player is reached at 127.0.0.1 through a published port: not the
  // address it serves on, which is the name-based case.
  expect(await page.evaluate('fppConfig.serverName !== fppConfig.serverAddr')).toBe(true);
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
  await expect(row).toContainText('master');
  const rowID = await row.getAttribute('id');
  expect(rowID).toBe('M1_fpptests_remote');
  await row.locator('input.remoteCheckbox').check();
  await page.evaluate('upgradeSelectedSystems()');
  await expect.poll(() => jobs.length, { timeout: 10_000 }).toBe(1);
  expect(jobs[0]).toEqual({ id: rowID, type: 'upgrade', ip: REMOTE, fallback: 'fpptests-remote' });
});
