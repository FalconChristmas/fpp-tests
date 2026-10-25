import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { StandIn } from './standin-http';

// MultiSync's Change Branch action, at UI level 1 and up: a Remote picker
// (origin or newfeatures) next to the branch list.  The branch list is this
// player's own api/git/branches?remote=<it>, read from a git repository put
// at /opt/fpp for the test (the served tree is an export, with none); the
// change itself is a changeBranch job in streamRemoteJobs.php, which asks the
// remote's changebranch.php.  The remote is a stand-in on a host of its own
// (standin-http.ts) that records that request; the page's view of its status
// is answered by the test.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let uiLevel = '0';

test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
  // origin has master, newfeatures a feature branch.
  inPlayer('sh', '-c', 'cd /opt/fpp && git init -q && c=$(git -c user.name=fpp-tests -c user.email=fpp-tests@invalid ' +
    'commit-tree $(git mktree < /dev/null) -m fpp-tests) && git update-ref refs/remotes/origin/master $c && ' +
    'git update-ref refs/remotes/newfeatures/fpp-tests-feature $c');
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-rf', '/opt/fpp/.git');
  await request.put('/api/settings/uiLevel', { data: uiLevel || '0' });
});

function system(address: string, hostname: string, uuid: string, local = 0) {
  return {
    address, hostname, local, fppMode: local ? 2 : 8, fppModeString: local ? 'player' : 'remote',
    typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
    version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
    channelRanges: '', multiSyncCapable: 1, multisync: false,
    lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
  };
}

async function openMultisync(page: Page, remote: string) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/fppd/multiSyncSystems', (route) => route.fulfill({ json: { systems: [
    system('192.168.0.13', 'FPPTESTLOCAL', 'M1-fpptests-local', 1), system(remote, 'fpptests-remote', 'M1-fpptests-remote'),
  ] } }));
  await page.route('**/api/system/status?**', (route) => route.fulfill({ json: { [remote]: {
    status_name: 'idle', mode_name: 'remote', mode: 8, warnings: [],
    advancedView: { Platform: 'Raspberry Pi', Branch: 'master', LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', Utilization: { CPU: 1, Memory: 2 } },
  } } }));
  await page.route('**/api/files/uploads', (route) => route.fulfill({ json: { files: [] } }));
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(2, { timeout: 15_000 });
  return page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
}

const branches = (page: Page) => page.locator('#branchSelect option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

test('picking the newfeatures remote lists its branches, and Change Branch sends that remote', async ({ page }) => {
  // Feature: b3e8dcb86.  Change Branch only ever offered, and switched to,
  // origin's branches; newfeatures' could not be picked.
  test.setTimeout(120_000);
  const peer = StandIn.sibling('branch-remote', { '/changebranch.php': { body: 'fpp-tests: switching\n' } });
  try {
    peer.start();
    page.on('dialog', (d) => d.accept());
    const row = await openMultisync(page, peer.address);
    // The control: origin's branches, from this player's repository.
    await expect.poll(() => branches(page), { timeout: 15_000 }).toEqual(['master']);

    const listed = page.waitForRequest((r) => r.url().includes('/api/git/branches?remote=newfeatures'));
    await page.selectOption('#multiAction', 'changeBranch');
    await page.selectOption('#branchRemoteSelect', 'newfeatures', { timeout: 10_000 });
    await listed;
    await expect.poll(() => branches(page)).toEqual(['fpp-tests-feature']);

    await row.locator('input.remoteCheckbox').check();
    await page.evaluate('performMultiAction()');
    // The remote's changebranch.php is asked for that remote's branch.  (Its
    // checks: branch /^[A-Za-z0-9_.\/-]+$/, remote /^[a-zA-Z0-9_-]+$/ or
    // origin is used instead.)
    await expect.poll(() => peer.requests().map((q) => q.path).filter((p) => p.startsWith('/changebranch.php')),
      { timeout: 30_000 }).toEqual(['/changebranch.php?branch=fpp-tests-feature&remote=newfeatures']);
  } finally {
    peer.stop();
  }
});
