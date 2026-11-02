import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, playerAddress } from './container';

// Upgrading remotes from the MultiSync page goes through one streaming
// request (streamRemoteJobs.php) naming each remote by address.  When the page
// was opened by host name rather than address, the remote's host name is sent
// as well, to be tried when the address can't be used: reaching hosts by
// address from a page opened by name is blocked by CORS.  The stream is stood
// in for, so what the page asked for is what is checked.

test.skip(!container, 'needs the address of the run-web.sh container');

const LOCAL = '192.168.0.13';
const REMOTE = '192.168.0.21';

function system(address: string, hostname: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid: `M1-fpptests-${hostname}`,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

const REMOTE_STATUS = {
  status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
  advancedView: {
    Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'bbb2222', UpgradeSource: 'github.com',
    IPs: [REMOTE], Utilization: { CPU: 12, Memory: 34 },
  },
};

// Opens the page at `base` and upgrades the remote; the job the page sent.
async function upgrade(page: Page, host: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system(LOCAL, 'FPPTESTLOCAL', 1), system(REMOTE, 'fpptests-remote'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [REMOTE]: REMOTE_STATUS } }));
  await page.route('**/api/git/branches', (route) => route.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  const bodies: string[] = [];
  await page.route('**/streamRemoteJobs.php', (route) => {
    bodies.push(route.request().postData() ?? '');
    const id = JSON.parse(route.request().postData() ?? '{}').jobs?.[0]?.id;
    return route.fulfill({ contentType: 'text/plain', body: JSON.stringify({ id, done: true, ok: true }) + '\n' });
  });
  // The Host header is what the page is "opened by": Apache sets SERVER_NAME
  // from it, and SERVER_ADDR is the address the player was reached on.
  await page.route('**/multisync.php', async (route) => {
    const response = await page.request.fetch(route.request(), { headers: { ...route.request().headers(), host } });
    await route.fulfill({ response });
  });
  await page.goto('/multisync.php');
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText('aaa1111', { timeout: 15_000 });
  await row.locator('input.remoteCheckbox').check();
  await page.selectOption('#multiAction', 'upgradeFPP');
  await page.locator('#performActionButton').click();
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(1);
  const jobs = JSON.parse(bodies[0]).jobs;
  expect(jobs).toHaveLength(1);
  return jobs[0];
}

test('opened by address, a remote is upgraded by its address alone', async ({ page }) => {
  // The control for the next test.
  const job = await upgrade(page, playerAddress().ip);
  expect(job).toMatchObject({ type: 'upgrade', ip: REMOTE });
  expect(job.fallback).toBeUndefined();
});

test('opened by host name, a remote is upgraded by its host name as well', async ({ page }) => {
  // Regression: 8a73e49c0.  The upgrade used the remote's address whatever
  // the page was opened by, which a page opened by name can't reach (CORS).
  const job = await upgrade(page, 'fpp-tests-player.example');
  expect(job).toMatchObject({ type: 'upgrade', ip: REMOTE, fallback: 'fpptests-remote' });
});
