import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import {
  PluginRepo, MEDIA, sh, exists, writeFile, installPlugin, uninstallPlugin, clonePlugin, runUpdateCheck, lineCount,
  linesAfter, routePluginList, clearPluginSourceSettings,
} from './plugin-backfill';

// Checking installed plugins for updates (the background check, its state in
// GET /api/plugin/updateStatus, POST .../updates for one plugin) and updating
// them (POST .../upgrade, the Plugins page's Update All), with what each says
// when something fails.

test.skip(!container, 'installs plugins from repositories inside the run-web.sh container');

const LOG = `${MEDIA}/logs/fpp_plugin_manager.log`;
const repos: PluginRepo[] = [];
function newRepo(name: string): PluginRepo {
  const r = new PluginRepo(name);
  repos.push(r);
  return r;
}

test.afterEach(() => {
  for (const r of repos.splice(0)) {
    r.remove();
  }
  sh(`rm -f /tmp/fpp-tests-upd-*; git config --system --remove-section url.file:///tmp/fpp-tests-repo-fpp-tests-upd-moved.git 2>/dev/null || true`);
  sh(`pkill -f '[f]pp-tests-silent-listener' || true`);
  clearPluginSourceSettings();
});

async function updateStatus(request: any): Promise<any> {
  return (await request.get('/api/plugin/updateStatus')).json();
}

async function checkOne(request: any, plugin: string, body?: unknown): Promise<any> {
  const r = await request.post(`/api/plugin/${plugin}/updates`, {
    data: body === undefined ? '' : JSON.stringify(body), timeout: 120_000,
  });
  return r.json();
}

test('the background check finds an update, the header shows it, and an update clears it', async ({ page, request }) => {
  // Feature: 1b2705a93 (plugin updates are checked on the server and kept in
  // GET /api/plugin/updateStatus; an install or update writes its own
  // verdict), 3070951e3 (the header's plugin-update icon, on every page).
  const repo = newRepo('fpp-tests-upd-stale');
  repo.init();
  clonePlugin(repo);
  runUpdateCheck();
  let st = await updateStatus(request);
  expect(st.plugins, JSON.stringify(st)).not.toContain(repo.name);

  // The control: with nothing waiting the icon is hidden.
  await page.goto('/index.php');
  await expect(page.locator('#navbarPluginUpdateAvail')).toBeHidden();

  repo.commit('v2', { 'v.txt': '2\n' });
  runUpdateCheck();
  st = await updateStatus(request);
  expect(st, JSON.stringify(st)).toMatchObject({ status: 'OK', updatesAvailable: true });
  expect(st.plugins).toContain(repo.name);

  await page.goto('/index.php');
  const icon = page.locator('#navbarPluginUpdateAvail');
  await expect(icon).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#navbarPluginUpdateAvailIcon')).toHaveAttribute('title', new RegExp(`available: .*${repo.name}`));
  await expect(icon.locator('a')).toHaveAttribute('href', 'plugins.php?tab=updates');

  const up = await (await request.post(`/api/plugin/${repo.name}/upgrade`, { timeout: 180_000 })).json();
  expect(up.Status, JSON.stringify(up)).toBe('OK');
  st = await updateStatus(request);
  expect(st.plugins).not.toContain(repo.name);
  await page.goto('/index.php');
  await expect(page.locator('#navbarPluginUpdateAvailIcon')).toBeAttached();
  await expect(icon).toBeHidden();
});

test("the background check's verdict is kept when it starts in the same second as an install's", async ({ request }) => {
  // Regression: 3b454c5d9.  A sweep drops its verdict when a user action
  // (an install, an update, a hand check) recorded one after its fetch began.
  // Both times were whole seconds and "after" was >=, so an install recorded
  // in the same second the sweep's fetch started -- an install then Update
  // All, at once -- threw away the sweep's "update available", and Update
  // All found nothing to update.  Each pass here records an install's
  // verdict at the start of a second, as InstallPluginFromInfo() does, and
  // starts the sweep straight after it, so they share a second.
  const repo = newRepo('fpp-tests-upd-samesec');
  repo.init();
  clonePlugin(repo);
  repo.commit('v2', { 'v.txt': '2\n' });
  const record = `
$f = '${MEDIA}/cache/plugin_updates.json';
$s = file_exists($f) ? json_decode(file_get_contents($f), true) : null;
if (!is_array($s) || !isset($s['plugins'])) $s = array('version' => 1, 'plugins' => array());
while (fmod(microtime(true), 1) > 0.05) usleep(2000);
$t = microtime(true);
$s['plugins']['${repo.name}'] = array('updates' => false, 'checkedAt' => (int) $t, 'recordedAt' => $t, 'error' => '', 'source' => 'install');
file_put_contents($f, json_encode($s));`;
  writeFile('/tmp/fpp-tests-upd-record.php', `<?php${record}\n`);
  for (let i = 0; i < 5; i++) {
    sh('php /tmp/fpp-tests-upd-record.php && php /opt/fpp/scripts/plugin_update_check.php --force > /dev/null 2>&1 || true');
    const st = await updateStatus(request);
    expect(st.plugins, `pass ${i + 1}: ${JSON.stringify(st)}`).toContain(repo.name);
  }
});

test('the background check logs a lasting failure once, and one summary line per pass', async ({ request }) => {
  // Regression: 62c3e1bf4.  Every pass wrote START and FINISH lines and
  // repeated every plugin that could not be checked, so one with a lasting
  // failure added lines to fpp_plugin_manager.log (which is also the install
  // history) for ever.  And an install ran the plugin's own networked
  // fpp_update_check.sh inside its stream; now the background check does.
  const good = newRepo('fpp-tests-upd-good');
  // A name of its own each run: a verdict recorded for it earlier (the
  // state outlives a plugin removed without an uninstall) is not news.
  const broken = newRepo(`fpp-tests-upd-broken-${Date.now() % 1000000}`);
  const marker = '/tmp/fpp-tests-upd-own-check-ran';
  good.init({}, { 'scripts/fpp_update_check.sh': `#!/bin/sh\ntouch ${marker}\nexit 0\n` });
  expect((await installPlugin(request, good.info())).Status).toBe('OK');
  expect(exists(marker), "the install ran the plugin's own update check").toBe(false);

  broken.init();
  clonePlugin(broken);
  sh(`git -C ${broken.dir} remote set-url origin http://127.0.0.1:9/fpp-tests-upd-broken.git`);
  const from = lineCount(LOG);
  runUpdateCheck();
  runUpdateCheck();
  const lines = linesAfter(LOG, from);
  expect(lines.filter((l) => l.includes(`[update-check ${broken.name}] could not check`)), lines.join('\n')).toHaveLength(1);
  expect(lines.filter((l) => l.includes('[update-check all] checked 2 plugins, 1 could not be checked')), lines.join('\n')).toHaveLength(2);
  expect(lines.filter((l) => /update check (START|FINISH)/.test(l)), lines.join('\n')).toEqual([]);
});

test('checking one plugin says why it could not, and gives up on a repository that never answers', async ({ request }) => {
  // Regression: c001c8b8c.  Every fetch ran with no time limit and threw its
  // error away: a remote that stopped answering held a web server worker for
  // good, and any failure came back as "could not run git fetch".
  test.setTimeout(180_000);
  let r = await checkOne(request, 'fpp-tests-upd-nothere');
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'Error', reason: 'not installed' });

  const repo = newRepo('fpp-tests-upd-dead');
  repo.init();
  clonePlugin(repo);
  sh(`git -C ${repo.dir} remote set-url origin http://127.0.0.1:9/x.git`);
  r = await checkOne(request, repo.name);
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'Error' });
  expect(r.reason).toContain('could not reach the repository host');

  // A listener that accepts and never says a word.
  inPlayer('sh', '-c', `nohup python3 -c "
import socket, time  # fpp-tests-silent-listener
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 39417)); s.listen(8); held = []
while True:
    c, _ = s.accept(); held.append(c)
" > /dev/null 2>&1 &`);
  sh(`git -C ${repo.dir} remote set-url origin http://127.0.0.1:39417/x.git`);
  const t0 = Date.now();
  r = await checkOne(request, repo.name);
  const secs = (Date.now() - t0) / 1000;
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'Error' });
  expect(r.reason).not.toBe('');
  expect(secs).toBeLessThan(90);
});

test('a plugin whose own origin is gone can still be checked from the listing URL, for a Reinstall', async ({ request }) => {
  // Regression: f24322c7b.  A clone whose origin alone had gone (the
  // repository moved) failed its update check, and Reinstall All skipped it
  // for good.  With the listing's srcURL in the request the server fetches
  // the reinstall target from there instead.  A github.com URL is mapped to
  // a local repository with git's insteadOf.
  const repo = newRepo('fpp-tests-upd-moved');
  const listed = 'https://github.com/fpp-tests/fpp-tests-upd-moved.git';
  sh(`git config --system url.${repo.url}.insteadOf ${listed}`);
  repo.init({ srcURL: listed });
  clonePlugin(repo);
  sh(`git -C ${repo.dir} remote set-url origin /tmp/fpp-tests-upd-gone.git`);

  let r = await checkOne(request, repo.name);
  expect(r.Status, JSON.stringify(r)).toBe('Error');
  r = await checkOne(request, repo.name, { srcURL: listed });
  expect(r, JSON.stringify(r)).toMatchObject({ Status: 'OK', originUnreachable: true, updatesAvailable: 0, privacyChanged: false });
  expect(repo.installed()).toBe(true);
});

test('after an OS upgrade the plugins still to reinstall are tracked one by one', async ({ request }) => {
  // Regression: 429d8a20b.  pluginReinstallNeededAfterOS was one flag, so a
  // single Reinstall (or uninstall) cleared it, and fppd's "plugins must be
  // reinstalled" warning with it, while other plugins were still stale.
  const a = newRepo('fpp-tests-upd-osa');
  const b = newRepo('fpp-tests-upd-osb');
  a.init();
  b.init();
  clonePlugin(a);
  clonePlugin(b);
  const setting = () => (sh(`grep '^pluginReinstallNeededAfterOS' ${MEDIA}/settings || true`).match(/"(.*)"/) || [, ''])[1];
  sh(`sed -i '/^pluginReinstallNeededAfterOS/d' ${MEDIA}/settings; echo 'pluginReinstallNeededAfterOS = "1"' >> ${MEDIA}/settings`);
  await request.get('/api/plugin');
  expect(setting()).toBe(`${a.name},${b.name}`);

  expect((await uninstallPlugin(request, a.name)).Status).toBe('OK');
  expect(setting(), 'one uninstall cleared the list').toBe(b.name);

  b.commit('v2', { 'v.txt': '2\n' });
  const up = await (await request.post(`/api/plugin/${b.name}/upgrade`, { timeout: 180_000 })).json();
  expect(up.Status, JSON.stringify(up)).toBe('OK');
  expect(setting()).toBe('');
});

test('an update says which phase failed, and does not run the script when the code did not move', async ({ request }) => {
  // Regression: 0e37a62ff.  Any failure was "Could not run git pull", so a
  // plugin whose own upgrade script failed looked like a git problem.
  const repo = newRepo('fpp-tests-upd-phase');
  const marker = '/tmp/fpp-tests-upd-script-ran';
  repo.init();
  clonePlugin(repo);
  const v2 = repo.commit('v2', { 'scripts/fpp_upgrade.sh': `#!/bin/sh\ntouch ${marker}\nexit 1\n` });
  let r = await (await request.post(`/api/plugin/${repo.name}/upgrade`, { timeout: 180_000 })).json();
  expect(r.Status).toBe('Error');
  expect(r.Message).toContain('was updated, but its install/upgrade script failed');
  expect(repo.installedHead()).toBe(v2);

  sh(`rm -f ${marker}`);
  repo.commit('v3', { 'v.txt': '3\n' });
  sh(`git -C ${repo.dir} remote set-url origin http://127.0.0.1:9/x.git`);
  r = await (await request.post(`/api/plugin/${repo.name}/upgrade`, { timeout: 180_000 })).json();
  expect(r.Status).toBe('Error');
  expect(r.Message).toMatch(/Could not (fetch updates for|update plugin)/);
  expect(exists(marker), 'the upgrade script ran on code that did not move').toBe(false);
  expect(repo.installedHead()).toBe(v2);
});

// The Plugins page, with the plugin list served by the test.
async function openPluginsPage(page: any, installed: string[]) {
  await routePluginList(page);
  await page.goto('/plugins.php');
  for (const p of installed) {
    await expect(page.locator(`[id="row-${p}"]`)).toBeAttached({ timeout: 20_000 });
  }
}

test('Check for Updates runs the server check and names what it could not check', async ({ page }) => {
  // Feature: d62d3345c.  The page asks the server to check (POST
  // /api/plugin/updateStatus/refresh) instead of fetching every plugin from
  // the browser, and the Updates tab says which plugin could not be checked
  // and why.
  const stale = newRepo('fpp-tests-upd-chk-stale');
  const dead = newRepo('fpp-tests-upd-chk-dead');
  stale.init();
  clonePlugin(stale);
  stale.commit('v2', { 'v.txt': '2\n' });
  dead.init();
  clonePlugin(dead);
  sh(`git -C ${dead.dir} remote set-url origin http://127.0.0.1:9/x.git`);

  await openPluginsPage(page, [stale.name, dead.name]);
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  const perPlugin: string[] = [];
  page.on('request', (r: any) => {
    if (/\/api\/plugin\/[^/]+\/updates$/.test(r.url())) perPlugin.push(r.url());
  });
  const refresh = page.waitForRequest((r: any) => r.url().endsWith('/api/plugin/updateStatus/refresh') && r.method() === 'POST');
  await page.locator('#checkAllUpdatesBtn').click();
  await refresh;
  await expect(page.locator('.jGrowl-message', { hasText: 'Checked 2 plugins' }))
    .toContainText(`1 update available, 1 could not be checked (${dead.name})`, { timeout: 90_000 });
  expect(perPlugin).toEqual([]);

  await page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]').click();
  const line = page.locator('#pluginUpdateStatusLine');
  await expect(line).toContainText(`${dead.name} - the player could not reach the repository host`);
  await expect(page.locator(`[id="row-${stale.name}"]`)).toHaveClass(/fppHasUpdate/);
});

test('the Installed count stays put on the Updates tab', async ({ page }) => {
  // Regression: 4ca26ff06.  The Installed badge counted the rows visible in
  // the current pane, so on the Updates tab, which shows only plugins with an
  // update, it dropped to 0.
  const repo = newRepo('fpp-tests-upd-count');
  repo.init();
  clonePlugin(repo);
  runUpdateCheck();
  await openPluginsPage(page, [repo.name]);
  const count = page.locator('#topCountInstalled');
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="installed"]').click();
  await expect(count).toHaveText('1');
  await page.locator('#pluginTopTabs .nav-link[data-top-tab="updates"]').click();
  await expect(page.locator('#pane-manage')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(count).toHaveText('1');
});
