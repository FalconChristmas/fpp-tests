import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

// The MultiSync page's actions on the ticked systems: Reboot, Shutdown, Set
// to Remote / Player mode (each a POST to a helper per system) and Copy
// Files (one streamRemoteJobs.php request for all of them).  What matters is
// which systems they reach: exactly the ticked ones still in view, each
// once, with the mode asked for.  The systems, their status and the helpers
// are the test's, so nothing is rebooted or copied.

const LOCAL = '192.0.2.13';
const REMOTES = ['192.0.2.21', '192.0.2.22', '192.0.2.23', '192.0.2.24'];
const system = (address: string, hostname: string, uuid: string, local: number, mode = 8) => ({
  address, hostname, local, fppMode: local ? 2 : mode, fppModeString: local ? 'player' : mode === 8 ? 'remote' : 'player',
  typeId: 13, type: 'Raspberry Pi 4', model: 'Raspberry Pi 4 Model B',
  version: '10.x-master-1-gaaa1111bb', majorVersion: 10, minorVersion: 0, uuid,
  channelRanges: '', multiSyncCapable: 1, multisync: false,
  lastSeen: 1780749445, lastSeenStr: '2026-06-06 07:37:25', HostDescription: '',
});
const SYSTEMS = { systems: [
  system(LOCAL, 'FPPTESTLOCAL', 'M1-fpptests-local', 1),
  ...REMOTES.map((ip, i) => system(ip, `fpptests-remote-${i}`, `M1-fpptests-remote-${i}`, 0, i === 3 ? 2 : 8)),
] };
const STATUS = Object.fromEntries(REMOTES.map((ip, i) => [ip, {
  status_name: 'idle', mode_name: i === 3 ? 'player' : 'remote', mode: i === 3 ? 2 : 8, warnings: [],
  advancedView: { Platform: 'Raspberry Pi', Version: '10.x-master-1-gaaa1111bb', Branch: 'master',
    LocalGitVersion: 'aaa1111', RemoteGitVersion: 'aaa1111', UpgradeSource: 'github.com', Utilization: { CPU: 12, Memory: 34 } },
}]));

type Calls = { helper: { path: string; ip: string; mode: string | null; method: string }[]; jobs: any[] };
async function openPage(page: Page): Promise<Calls> {
  const calls: Calls = { helper: [], jobs: [] };
  await page.route('**/api/proxies', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/git/branches**', (r) => r.fulfill({ json: ['master'] }));
  await page.route('**/api/files/uploads', (r) => r.fulfill({ json: { files: [] } }));
  await page.route('**/api/fppd/multiSyncSystems', (r) => r.fulfill({ json: SYSTEMS }));
  await page.route('**/api/system/status?**', (r) => r.fulfill({ json: STATUS }));
  await page.route('**/CSP_regeneration_script.php', (r) => r.fulfill({ body: '' }));
  await page.route(/\/(rebootRemoteFPP|shutdownRemoteFPP|restartRemoteFPPD)\.php/, (r) => {
    const u = new URL(r.request().url());
    calls.helper.push({ path: u.pathname.replace(/^.*\//, ''), ip: u.searchParams.get('ip') || '', mode: u.searchParams.get('mode'), method: r.request().method() });
    return r.fulfill({ body: `fpp-tests ${u.pathname} ${u.searchParams.get('ip')}\n` });
  });
  await page.route('**/streamRemoteJobs.php', (r) => {
    const req = JSON.parse(r.request().postData() || '{}');
    calls.jobs.push(req);
    const lines = req.jobs.flatMap((j: any) => [{ id: j.id, out: `fpp-tests copied to ${j.ip}\n` }, { id: j.id, done: true, ok: true }]);
    return r.fulfill({ body: lines.map((l: any) => JSON.stringify(l)).join('\n') + '\n' });
  });
  await page.goto('/multisync.php');
  await expect(page.locator('#fppSystems tr.systemRow')).toHaveCount(5, { timeout: 15_000 });
  return calls;
}

const box = (page: Page, ip: string) => page.locator(`input.remoteCheckbox[name="${ip}"]`);
async function run(page: Page, action: string, ips: string[]) {
  await page.locator('#multiAction').selectOption(action);
  for (const ip of ips) await box(page, ip).check();
  await page.locator('#performActionButton').click();
}

for (const [action, path, mode] of [
  ['reboot', 'rebootRemoteFPP.php', null],
  ['shutdown', 'shutdownRemoteFPP.php', null],
  ['remoteMode', 'restartRemoteFPPD.php', 'remote'],
  ['playerMode', 'restartRemoteFPPD.php', 'player'],
] as const) {
  test(`${action} reaches the ticked systems only, each once`, async ({ page }) => {
    const calls = await openPage(page);
    await run(page, action, [REMOTES[0], REMOTES[2]]);
    await expect.poll(() => calls.helper.length, { timeout: 10_000 }).toBe(2);
    await page.waitForTimeout(500);
    expect(calls.helper.map((c) => c.ip).sort()).toEqual([REMOTES[0], REMOTES[2]]);
    for (const c of calls.helper) expect(c).toMatchObject({ path, mode, method: 'POST' });

    // Each ticked row shows the helper's answer in its log and is unticked;
    // the others have no log and stay as they were.
    for (const ip of [REMOTES[0], REMOTES[2]]) {
      await expect(box(page, ip)).not.toBeChecked();
      const row = page.locator(`#fppSystems tr.systemRow[data-ip="${ip}"]`);
      const id = await row.getAttribute('id');
      await expect(page.locator(`[id="${id}_logText"]`)).toHaveValue(new RegExp(`fpp-tests /${path} ${ip.replace(/\./g, '\\.')}`));
    }
    const other = await page.locator(`#fppSystems tr.systemRow[data-ip="${REMOTES[1]}"]`).getAttribute('id');
    await expect(page.locator(`[id="${other}_logs"]`)).toBeHidden();
  });
}

test('an action with nothing ticked reaches no system, and no action chosen says so', async ({ page }) => {
  const calls = await openPage(page);
  for (const action of ['reboot', 'shutdown', 'playerMode', 'copyFiles']) {
    await page.locator('#multiAction').selectOption(action);
    await page.locator('#performActionButton').click();
  }
  await page.waitForTimeout(1000);
  expect(calls.helper).toEqual([]);
  expect(calls.jobs).toEqual([]);

  const alerts: string[] = [];
  page.on('dialog', (d) => { alerts.push(d.message()); return d.accept(); });
  await page.locator('#multiAction').selectOption({ index: 0 });
  await box(page, REMOTES[0]).check();
  await page.locator('#performActionButton').click();
  await expect.poll(() => alerts).toEqual(['You must select an action first.']);
  expect(calls.helper).toEqual([]);
});

test('a system ticked and then filtered out of view is left alone', async ({ page }) => {
  const calls = await openPage(page);
  await box(page, REMOTES[0]).check();
  await box(page, REMOTES[3]).check();
  // remote-3 is a player; filtering to remotes takes it out of view.
  await page.locator('select.bootstrap-table-filter-control-mode').selectOption({ label: 'Remote' });
  await expect(page.locator(`#fppSystems tr.systemRow[data-ip="${REMOTES[3]}"]`)).toHaveCount(0);
  await page.locator('#multiAction').selectOption('reboot');
  await page.locator('#performActionButton').click();
  await expect.poll(() => calls.helper.length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(500);
  expect(calls.helper.map((c) => c.ip)).toEqual([REMOTES[0]]);
});

test('Copy Files sends one request with a job per ticked system, at most four at a time', async ({ page }) => {
  const calls = await openPage(page);
  await run(page, 'copyFiles', [REMOTES[1], REMOTES[2], REMOTES[3]]);
  await expect.poll(() => calls.jobs.length, { timeout: 10_000 }).toBe(1);
  const [req] = calls.jobs;
  expect(req.maxParallel).toBe(4);
  expect(req.jobs.map((j: any) => [j.type, j.ip]).sort()).toEqual(
    [REMOTES[1], REMOTES[2], REMOTES[3]].map((ip) => ['copyFiles', ip]));
  // The row ids are the rows', so each answer lands in its own log.
  for (const j of req.jobs) {
    await expect(page.locator(`[id="${j.id}_logText"]`)).toHaveValue(new RegExp(`fpp-tests copied to ${j.ip.replace(/\./g, '\\.')}`));
    await expect(page.locator(`[id="${j.id}_doneButtons"]`)).toBeVisible();
  }
  for (const ip of [REMOTES[1], REMOTES[2], REMOTES[3]]) await expect(box(page, ip)).not.toBeChecked();
  expect(calls.helper).toEqual([]);
  // Done, the buttons are usable again.
  await expect(page.locator('#performActionButton')).toBeEnabled();
});
