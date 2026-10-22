import { test, expect } from './fixtures';
import { container } from './container';
import {
  PluginRepo, CONFIG, sh, exists, readFile, fileHasText, historyOf, installPlugin, installPluginStreamed, uninstallPlugin,
  clearPluginSourceSettings,
} from './plugin-backfill';
import { installFakeApt, removeFakeApt, fakeAptState, aptChanges } from './fake-apt';

// What FPP does with a plugin's system packages: the ones its pluginInfo.json
// declares, the claims it records for them in config/userpackages.json, what
// a release of those claims removes, and what the install history says
// changed.  apt and dpkg are fake-apt.py, which knows a few fpp-tests-pkg-*
// packages and records every call, so nothing is really installed or removed.

test.skip(!container, 'installs plugins and a fake apt inside the run-web.sh container');

const PLUGIN = 'fpp-tests-pkgs';
const repo = new PluginRepo(PLUGIN);
const USERPACKAGES = `${CONFIG}/userpackages.json`;

test.afterEach(() => {
  repo.remove();
  removeFakeApt();
  sh(`rm -f ${USERPACKAGES} /tmp/fpp-tests-pkgs-*`);
  clearPluginSourceSettings();
});

type Claim = { package: string; requestedBy: string[]; preinstalled?: boolean };
function claims(): Claim[] {
  return exists(USERPACKAGES) ? JSON.parse(readFile(USERPACKAGES)) : [];
}

const deps = (...packages: string[]) => ({ dependencies: { packages } });

test("a failed install releases the packages its other dependencies installed, and is recorded", async ({ request }) => {
  // Regression: a0660bc34.  When one required package could not be
  // installed the install was refused and the plugin removed, but a package
  // the same attempt had just installed for it stayed claimed by a plugin
  // that was no longer there, and the history had no entry for the attempt.
  installFakeApt({ available: ['fpp-tests-pkg-ok'] });
  repo.init(deps('fpp-tests-pkg-ok', 'fpp-tests-pkg-missing'));
  const before = historyOf(PLUGIN).length;
  const r = await installPlugin(request, repo.info());
  expect(r.Status, JSON.stringify(r)).toBe('Error');
  expect(repo.installed()).toBe(false);

  // The control: the good one really was installed first.
  expect(aptChanges()).toContain('apt-get install -y fpp-tests-pkg-ok');
  expect(aptChanges()).toContain('apt-get remove -y fpp-tests-pkg-ok');
  expect(Object.keys(fakeAptState().installed)).not.toContain('fpp-tests-pkg-ok');
  expect(claims().filter((c) => c.requestedBy.includes(PLUGIN))).toEqual([]);

  const h = historyOf(PLUGIN).slice(before);
  expect(h.map((e) => e.action)).toEqual(['install']);
  expect(h[0]).toMatchObject({ failed: 'dependencies', srcURL: repo.url });
  expect(h[0].fppPackages?.addedRemoved).toEqual(['fpp-tests-pkg-ok:all 1.0']);
});

test("the history records the packages FPP installed for a plugin's dependencies", async ({ request }) => {
  // Feature: e86b43642 (a plugin's declared packages are installed and
  // claimed for it), 597c10213.  An install's history entry carries 'fppPackages',
  // what changed while FPP installed the declared dependencies, and
  // 'startedAt'; a plugin with no dependencies gets no package window; when
  // the package list can't be read the entry says 'unknown'.
  installFakeApt({ available: ['fpp-tests-pkg-ok'] });
  repo.init(deps('fpp-tests-pkg-ok'));
  const before = historyOf(PLUGIN).length;
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  let h = historyOf(PLUGIN).slice(before);
  expect(h[0].fppPackages).toEqual({ added: ['fpp-tests-pkg-ok:all 1.0'] });
  expect(h[0].startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-ok', requestedBy: [PLUGIN] }]);
  await uninstallPlugin(request, PLUGIN);

  // No dependencies, no window.
  repo.setInfo({});
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  await uninstallPlugin(request, PLUGIN);

  // A package list that can't be read.
  installFakeApt({ available: ['fpp-tests-pkg-ok'], listFails: true });
  repo.setInfo(deps('fpp-tests-pkg-ok'));
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');

  h = historyOf(PLUGIN).slice(before).filter((e) => e.action === 'install');
  expect(h.length).toBe(3);
  expect(h[1].fppPackages).toBeUndefined();
  expect(h[2].fppPackages).toEqual({ unknown: true });
});

test('a package that was on the box only as a dependency is claimed, and not removed with the plugin', async ({ request }) => {
  // Regression: b3f34efe2.  A package apt had marked "auto" (there only as
  // another package's dependency) is claimed when a plugin declares it, so an
  // OS-upgrade replay brings it back; but the claim looked like one FPP had
  // installed, and uninstalling the plugin apt-removed the package.
  installFakeApt({ installed: { 'fpp-tests-pkg-auto': { auto: true } } });
  repo.init(deps('fpp-tests-pkg-auto'));
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-auto', requestedBy: [PLUGIN], preinstalled: true }]);

  const u = await uninstallPlugin(request, PLUGIN);
  expect(u.Status, JSON.stringify(u)).toBe('OK');
  expect(aptChanges().filter((c) => c.includes(' remove ')), 'the plugin took the package with it').toEqual([]);
  expect(Object.keys(fakeAptState().installed)).toContain('fpp-tests-pkg-auto');
  expect(claims()).toEqual([]);
});

test('a package that was already installed is never claimed or removed by a plugin', async ({ request }) => {
  // Regression: 3b176b3dc.  Uninstalling a plugin apt-removed every package it
  // declared once no other requester was left, including ones already on the
  // box from the image or the user (a plugin declaring fontconfig took ffmpeg
  // and gstreamer with it, as 'apt-get remove' takes every reverse
  // dependency).
  installFakeApt({ installed: { 'fpp-tests-pkg-image': { auto: false } } });
  repo.init(deps('fpp-tests-pkg-image'));
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');
  expect(aptChanges(), 'apt was asked to install a package already there').toEqual([]);
  expect(claims()).toEqual([]);

  const u = await uninstallPlugin(request, PLUGIN);
  expect(u.Status, JSON.stringify(u)).toBe('OK');
  expect(aptChanges().filter((c) => c.includes(' remove ')), 'the plugin took the package with it').toEqual([]);
  expect(Object.keys(fakeAptState().installed)).toContain('fpp-tests-pkg-image');
});

test("the package changes made while a plugin's install script ran are reported and recorded", async ({ request }) => {
  // Feature: e864a89e9.  A plugin's own script that removes or holds a system
  // package says so in the install output and the plugin manager log, and
  // the history entry lists the change ('packages').
  installFakeApt({ installed: { 'fpp-tests-pkg-victim': {}, 'fpp-tests-pkg-held': {} } });
  repo.init({}, {
    'scripts/fpp_install.sh': '#!/bin/sh\napt-get remove -y fpp-tests-pkg-victim\napt-mark hold fpp-tests-pkg-held\n',
  });
  const before = historyOf(PLUGIN).length;
  const out = await installPluginStreamed(request, repo.info());
  const line = `System packages changed while ${PLUGIN}'s install script was running: removed 1 (fpp-tests-pkg-victim); held 1 (fpp-tests-pkg-held).`;
  expect(out).toContain(line);
  expect(fileHasText('/home/fpp/media/logs/fpp_plugin_manager.log', line)).toBe(true);
  const h = historyOf(PLUGIN).slice(before);
  expect(h[0].packages).toEqual({ removed: ['fpp-tests-pkg-victim:all'], held: ['fpp-tests-pkg-held:all'] });
});

test('an update installs the dependencies the new version declares before its script, and stops if one fails', async ({ request }) => {
  // Regression: 12c057816.  An update pulled the new code and ran
  // fpp_upgrade.sh without looking at the version's declared dependencies, so
  // an update that needed a new package "succeeded" and ran its script
  // without it.
  installFakeApt({ available: ['fpp-tests-pkg-ok'] });
  const marker = '/tmp/fpp-tests-pkgs-upgraded';
  repo.init();
  expect((await installPlugin(request, repo.info())).Status).toBe('OK');

  // v2 needs a package that does not exist.
  repo.commit('v2', {
    'pluginInfo.json': JSON.stringify(repo.info(deps('fpp-tests-pkg-missing'))),
    'scripts/fpp_upgrade.sh': `#!/bin/sh\ndpkg-query -W -f='\${db:Status-Status}' fpp-tests-pkg-ok > ${marker} 2>&1; echo >> ${marker}\n`,
  });
  let r = await request.post(`/api/plugin/${PLUGIN}/upgrade`, { timeout: 180_000 });
  let body = await r.json();
  expect(body.Status, JSON.stringify(body)).toBe('Error');
  expect(body.Message).toContain('script failed');
  expect(exists(marker), 'the upgrade script ran without its dependency').toBe(false);
  expect(historyOf(PLUGIN).slice(-1)[0]).toMatchObject({ action: 'upgrade', dependencyFailed: true });

  // v3 needs one that does: it is installed, then the script runs and sees it.
  repo.setInfo(deps('fpp-tests-pkg-ok'), 'v3');
  r = await request.post(`/api/plugin/${PLUGIN}/upgrade`, { timeout: 180_000 });
  body = await r.json();
  expect(body.Status, JSON.stringify(body)).toBe('OK');
  expect(readFile(marker).trim()).toBe('installed');
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-ok', requestedBy: [PLUGIN] }]);
});

test("the Package Manager's Reinstall reinstalls the package and leaves the list alone", async ({ request }) => {
  // Feature: 418f0df17.  packagesHelper.php?action=reinstall runs
  // 'apt-get install --reinstall' for the package, as one argument.
  installFakeApt({ installed: { 'fpp-tests-pkg-ok': {} } });
  const r = await request.post('/packagesHelper.php', { form: { action: 'reinstall', package: 'fpp-tests-pkg-ok' }, timeout: 120_000 });
  expect(await r.text()).toContain('Completed');
  expect(aptChanges()).toEqual(['apt-get install --reinstall -y fpp-tests-pkg-ok']);
  expect(claims()).toEqual([]);

  const bad = await request.post('/packagesHelper.php', { form: { action: 'reinstall', package: 'fpp-tests-pkg-ok;id' } });
  expect(await bad.text()).toContain('Invalid package name');
  expect(aptChanges().length).toBe(1);
});
