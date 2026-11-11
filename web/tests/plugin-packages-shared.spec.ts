import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, CONFIG, sh, exists, readFile, writeFile, installPlugin, uninstallPlugin, clearPluginSourceSettings } from './plugin-backfill';
import { installFakeApt, removeFakeApt, fakeAptState, aptChanges } from './fake-apt';

// Uninstalling a plugin removes the system packages FPP installed for it
// (ReleasePackageClaims()), but never one something else still needs: another
// plugin or the Package Manager that also asked for it, or an installed
// package that depends on it, which 'apt-get remove' would take with it.
// Getting this wrong uninstalls part of the player along with the plugin.
// apt is fake-apt.py, its dependencies the test's (plugin-packages.spec.ts
// has the single-plugin cases).

test.skip(!container, 'installs plugins and a fake apt inside the run-web.sh container');
test.describe.configure({ timeout: 240_000 });

const USERPACKAGES = `${CONFIG}/userpackages.json`;
const repos: PluginRepo[] = [];
function plugin(name: string, ...packages: string[]) {
  const r = new PluginRepo(name);
  repos.push(r);
  r.init({ dependencies: { packages } });
  return r;
}

test.afterEach(() => {
  for (const r of repos.splice(0)) r.remove();
  removeFakeApt();
  sh(`rm -f ${USERPACKAGES}`);
  clearPluginSourceSettings();
});

type Claim = { package: string; requestedBy: string[] };
const claims = (): Claim[] => (exists(USERPACKAGES) ? JSON.parse(readFile(USERPACKAGES)) : []);
const installed = () => Object.keys(fakeAptState().installed).sort();
const removes = () => aptChanges().filter((c) => c.includes(' remove '));

async function install(request: any, r: PluginRepo) {
  const got = await installPlugin(request, r.info());
  expect(got.Status, JSON.stringify(got)).toBe('OK');
}
async function uninstall(request: any, r: PluginRepo) {
  const got = await uninstallPlugin(request, r.name, '?stream=true');
  return String(got.raw ?? JSON.stringify(got));
}

test('a package two plugins need stays until the second of them is uninstalled', async ({ request }) => {
  installFakeApt({ available: ['fpp-tests-pkg-shared'] });
  const a = plugin('fpp-tests-pkgshare-a', 'fpp-tests-pkg-shared');
  const b = plugin('fpp-tests-pkgshare-b', 'fpp-tests-pkg-shared');
  await install(request, a);
  await install(request, b);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-shared', requestedBy: [a.name, b.name] }]);

  const out = await uninstall(request, a);
  expect(out).toContain(`Package 'fpp-tests-pkg-shared' is still required by: ${b.name} - leaving it installed.`);
  expect(removes()).toEqual([]);
  expect(installed()).toContain('fpp-tests-pkg-shared');
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-shared', requestedBy: [b.name] }]);

  await uninstall(request, b);
  expect(removes().map((c) => c.split(' ').pop())).toEqual(['fpp-tests-pkg-shared']);
  expect(installed()).not.toContain('fpp-tests-pkg-shared');
  expect(claims()).toEqual([]);
});

test('a package the Package Manager also installed is not removed with the plugin', async ({ request }) => {
  installFakeApt({ available: ['fpp-tests-pkg-both'] });
  const a = plugin('fpp-tests-pkgshare-a', 'fpp-tests-pkg-both');
  await install(request, a);
  // The user then installed it by name on the Package Manager page as well.
  writeFile(USERPACKAGES, JSON.stringify([{ package: 'fpp-tests-pkg-both', requestedBy: [a.name, 'user'] }]));

  const out = await uninstall(request, a);
  expect(out).toContain("Package 'fpp-tests-pkg-both' is still required by: the Package Manager - leaving it installed.");
  expect(removes()).toEqual([]);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-both', requestedBy: ['user'] }]);
});

test("a plugin's package that something installed since depends on is kept; the rest of its packages go", async ({ request }) => {
  // The plugin brought in -lib and -tool; -other, installed later by hand,
  // needs -lib too, so removing -lib would take -other with it.
  installFakeApt({
    available: ['fpp-tests-pkg-lib', 'fpp-tests-pkg-tool'],
    depends: { 'fpp-tests-pkg-other': ['fpp-tests-pkg-lib'] },
  });
  const a = plugin('fpp-tests-pkgshare-a', 'fpp-tests-pkg-lib', 'fpp-tests-pkg-tool');
  await install(request, a);
  expect(installed()).toEqual(['fpp-tests-pkg-lib', 'fpp-tests-pkg-tool']);
  sh(`python3 -c "import json;f='/tmp/fpp-tests-apt/state.json';s=json.load(open(f));s['installed']['fpp-tests-pkg-other']={'version':'1.0'};json.dump(s,open(f,'w'))"`);

  const out = await uninstall(request, a);
  expect(out).toContain("Package 'fpp-tests-pkg-lib' is still used by fpp-tests-pkg-other - leaving it installed and no longer tracking it.");
  expect(removes().map((c) => c.split(' ').pop())).toEqual(['fpp-tests-pkg-tool']);
  expect(installed()).toEqual(['fpp-tests-pkg-lib', 'fpp-tests-pkg-other']);
  expect(claims()).toEqual([]);
});

test('packages that depend on one another in the plugin are removed together', async ({ request }) => {
  // -tool needs -lib; both were the plugin's, so nothing outside it is lost.
  installFakeApt({
    available: ['fpp-tests-pkg-lib', 'fpp-tests-pkg-tool'],
    depends: { 'fpp-tests-pkg-tool': ['fpp-tests-pkg-lib'] },
  });
  const a = plugin('fpp-tests-pkgshare-a', 'fpp-tests-pkg-lib', 'fpp-tests-pkg-tool');
  await install(request, a);
  await uninstall(request, a);
  expect(removes()).toHaveLength(1);
  expect(removes()[0]).toMatch(/remove -y fpp-tests-pkg-lib fpp-tests-pkg-tool$/);
  expect(installed()).toEqual([]);
});
