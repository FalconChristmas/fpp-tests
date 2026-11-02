import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';

// MultiSync's Change Branch action refuses a branch it would not send, in the
// page: none selected, or a name outside changebranch.php's allow-list.  Nothing
// is sent to the remotes for either (the batch goes to streamRemoteJobs.php).

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let uiLevel = '0';
test.beforeEach(async ({ request }) => {
  uiLevel = String((await (await request.get('/api/settings/uiLevel')).json()).value ?? '0');
  expect((await request.put('/api/settings/uiLevel', { data: '1' })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
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

async function openMultisync(page: Page) {
  const remote = '192.168.0.14';
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/proxies', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/git/branches*', (route) => route.fulfill({ json: [] }));
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
  const row = page.locator('#fppSystems tr.systemRow', { hasText: 'fpptests-remote' });
  await row.locator('input.remoteCheckbox').check();
  await page.selectOption('#multiAction', 'changeBranch');
  return row;
}

async function tryBranch(page: Page, value: string | null) {
  const sent: string[] = [];
  await page.route('**/streamRemoteJobs.php*', (route) => { sent.push(route.request().url()); return route.abort(); });
  await page.evaluate((v) => {
    const sel = document.getElementById('branchSelect') as HTMLSelectElement;
    sel.innerHTML = '';
    if (v !== null) {
      const o = document.createElement('option');
      o.value = v; o.text = v; sel.appendChild(o); sel.value = v;
    }
    (window as any).performMultiAction();
  }, value);
  return sent;
}

test('Change Branch with no branch selected says so and sends nothing', async ({ page }) => {
  // Regression: 48b3f6040.  With nothing in the branch list the action went
  // on to run changeBranch jobs with an empty branch.
  await openMultisync(page);
  const sent = await tryBranch(page, null);
  await expect(page.locator('.jGrowl-message', { hasText: 'No branch selected' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1000);
  expect(sent).toEqual([]);
});

for (const bad of ['--upload-pack=x', 'master..x', 'a b']) {
  test(`Change Branch refuses "${bad}" before asking any remote`, async ({ page }) => {
    // Regression: 48b3f6040.  The branch was sent as picked and only the
    // remote's changebranch.php refused it; the page now checks the same
    // allow-list first.
    await openMultisync(page);
    const sent = await tryBranch(page, bad);
    await expect(page.locator('.jGrowl-message', { hasText: `Invalid branch: ${bad}` })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    expect(sent).toEqual([]);
  });
}

test('Change Branch with a valid branch does send the job (control)', async ({ page }) => {
  await openMultisync(page);
  page.on('dialog', (d) => d.accept());
  const sent = await tryBranch(page, 'fpp-tests-feature');
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(0);
});
