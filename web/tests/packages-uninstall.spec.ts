import { test, expect } from './fixtures';
import { container } from './container';
import { PluginRepo, CONFIG, sh, exists, readFile, writeFile, installPlugin, uninstallPlugin, clearPluginSourceSettings } from './plugin-backfill';
import { installFakeApt, removeFakeApt, fakeAptState, aptChanges } from './fake-apt';

// The Package Manager's Uninstall (packagesHelper.php?action=uninstall, then
// ReleasePackageClaims for 'user'): it removes the package and the
// dependencies its install pulled in, but only what nothing else needs, and
// when apt cannot remove them cleanly it keeps the user's rows so they can
// see why the package stayed, and so a failed removal can be retried.
// apt is fake-apt.py; the manifest rows are written by the test.

test.skip(!container, 'installs a fake apt inside the run-web.sh container');
test.describe.configure({ timeout: 240_000 });

const USERPACKAGES = `${CONFIG}/userpackages.json`;
type Claim = { package: string; requestedBy: string[]; via?: string[] };
const claims = (): Claim[] => (exists(USERPACKAGES) ? JSON.parse(readFile(USERPACKAGES)) : []);
const setClaims = (c: Claim[]) => writeFile(USERPACKAGES, JSON.stringify(c));
const installed = () => Object.keys(fakeAptState().installed).sort();
const removes = () => aptChanges().filter((c) => c.includes(' remove '));
const fake = (...names: string[]) => Object.fromEntries(names.map((n) => [n, {}]));

const repos: PluginRepo[] = [];
test.afterEach(() => {
  for (const r of repos.splice(0)) r.remove();
  removeFakeApt();
  sh(`rm -f ${USERPACKAGES}`);
  clearPluginSourceSettings();
});

async function uninstall(request: any, pkg: string) {
  const r = await request.post('/packagesHelper.php', { form: { action: 'uninstall', package: pkg }, timeout: 120_000 });
  return r.text();
}

test("the page's Uninstall removes the package and the dependency it pulled in, together", async ({ page }) => {
  installFakeApt({ installed: fake('fpp-tests-pkg-tool', 'fpp-tests-pkg-lib'), depends: { 'fpp-tests-pkg-tool': ['fpp-tests-pkg-lib'] } });
  setClaims([
    { package: 'fpp-tests-pkg-tool', requestedBy: ['user'] },
    { package: 'fpp-tests-pkg-lib', requestedBy: ['user'], via: ['fpp-tests-pkg-tool'] },
  ]);
  await page.goto('/packages.php');
  const row = page.locator('#userPackagesTable tr', { has: page.locator('td.pkg-name', { hasText: 'fpp-tests-pkg-tool' }) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.locator('td.pkg-actions button', { hasText: 'Uninstall' }).click();
  await expect(page.locator('#packageProgressPopup')).toContainText('Uninstalling Package: fpp-tests-pkg-tool');
  await expect(page.locator('#packageProgressPopupText')).toHaveValue(/Completed/, { timeout: 60_000 });
  expect(removes()).toHaveLength(1);
  expect(removes()[0]).toMatch(/remove -y fpp-tests-pkg-tool fpp-tests-pkg-lib$/);
  expect(installed()).toEqual([]);
  expect(claims()).toEqual([]);
});

test('a package or dependency a plugin also claims stays, and only the user claim goes', async ({ request }) => {
  installFakeApt({ installed: fake('fpp-tests-pkg-tool', 'fpp-tests-pkg-lib') });
  setClaims([
    { package: 'fpp-tests-pkg-tool', requestedBy: ['user'] },
    { package: 'fpp-tests-pkg-lib', requestedBy: ['user', 'fpp-tests-plugin'], via: ['fpp-tests-pkg-tool'] },
  ]);
  const out = await uninstall(request, 'fpp-tests-pkg-tool');
  expect(out).toContain("Package 'fpp-tests-pkg-lib' is still required by: fpp-tests-plugin - leaving it installed.");
  expect(out).toContain('Completed');
  expect(removes().map((c) => c.split(' ').pop())).toEqual(['fpp-tests-pkg-tool']);
  expect(installed()).toEqual(['fpp-tests-pkg-lib']);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-lib', requestedBy: ['fpp-tests-plugin'] }]);
});

test('a package something else installed depends on is kept, and so is its row', async ({ request }) => {
  installFakeApt({
    installed: fake('fpp-tests-pkg-lib', 'fpp-tests-pkg-other'),
    depends: { 'fpp-tests-pkg-other': ['fpp-tests-pkg-lib'] },
  });
  setClaims([{ package: 'fpp-tests-pkg-lib', requestedBy: ['user'] }]);
  const out = await uninstall(request, 'fpp-tests-pkg-lib');
  // Unlike a plugin's release, the user's row stays: it shows why it was kept.
  expect(out).toContain("Package 'fpp-tests-pkg-lib' is still used by fpp-tests-pkg-other - leaving it installed.");
  expect(out).not.toContain('no longer tracking');
  expect(out).toContain('Nothing removed');
  expect(removes()).toEqual([]);
  expect(installed()).toEqual(['fpp-tests-pkg-lib', 'fpp-tests-pkg-other']);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-lib', requestedBy: ['user'] }]);
});

test('a removal that would make apt install something is refused; the user row is kept, a plugin claim dropped', async ({ request }) => {
  installFakeApt({ installed: fake('fpp-tests-pkg-alt'), available: ['fpp-tests-pkg-alt'],
    removeInstalls: { 'fpp-tests-pkg-alt': ['fpp-tests-pkg-alt2'] } });
  setClaims([{ package: 'fpp-tests-pkg-alt', requestedBy: ['user'] }]);
  const out = await uninstall(request, 'fpp-tests-pkg-alt');
  expect(out).toContain('Not removing fpp-tests-pkg-alt: apt would also install or upgrade 1 package(s). Leaving installed.');
  expect(out).toContain('Nothing removed');
  expect(removes()).toEqual([]);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-alt', requestedBy: ['user'] }]);

  // A plugin's claim on it is dropped instead, so it is not simulated again
  // on every later upgrade.
  const r = new PluginRepo('fpp-tests-pkgrm');
  repos.push(r);
  r.init({ dependencies: { packages: ['fpp-tests-pkg-alt'] } });
  sh(`rm -f ${USERPACKAGES}`);
  removeFakeApt();
  installFakeApt({ available: ['fpp-tests-pkg-alt'], removeInstalls: { 'fpp-tests-pkg-alt': ['fpp-tests-pkg-alt2'] } });
  const got = await installPlugin(request, r.info());
  expect(got.Status, JSON.stringify(got)).toBe('OK');
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-alt', requestedBy: [r.name] }]);
  const u = await uninstallPlugin(request, r.name, '?stream=true');
  expect(String(u.raw ?? JSON.stringify(u))).toContain('Leaving installed and no longer tracking.');
  expect(removes()).toEqual([]);
  expect(installed()).toEqual(['fpp-tests-pkg-alt']);
  expect(claims()).toEqual([]);
});

test('a failed apt-get remove keeps the rows, and the retry removes the package', async ({ request }) => {
  installFakeApt({ installed: fake('fpp-tests-pkg-tool'), removeFails: true });
  setClaims([{ package: 'fpp-tests-pkg-tool', requestedBy: ['user'] }]);
  const out = await uninstall(request, 'fpp-tests-pkg-tool');
  expect(out).toContain("Warning: 'apt-get remove' exited 100; keeping fpp-tests-pkg-tool in the package list so it can be retried.");
  expect(out).toContain('Nothing removed');
  expect(installed()).toEqual(['fpp-tests-pkg-tool']);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-tool', requestedBy: ['user'] }]);

  const s = fakeAptState();
  writeFile('/tmp/fpp-tests-apt/state.json', JSON.stringify({ ...s, removeFails: false }));
  expect(await uninstall(request, 'fpp-tests-pkg-tool')).toContain('Completed');
  expect(installed()).toEqual([]);
  expect(claims()).toEqual([]);
});

test("a package only a plugin claims, or one FPP did not install, is refused without touching apt", async ({ request }) => {
  installFakeApt({ installed: fake('fpp-tests-pkg-tool', 'fpp-tests-pkg-other') });
  setClaims([{ package: 'fpp-tests-pkg-tool', requestedBy: ['fpp-tests-plugin'] }]);
  expect(await uninstall(request, 'fpp-tests-pkg-tool'))
    .toContain("Package 'fpp-tests-pkg-tool' was not installed from this page; uninstall the owning plugin instead.\nFailed");
  expect(await uninstall(request, 'fpp-tests-pkg-other'))
    .toContain("Package 'fpp-tests-pkg-other' is not managed by FPP; nothing to uninstall.\nFailed");
  expect(aptChanges()).toEqual([]);
  expect(installed()).toEqual(['fpp-tests-pkg-other', 'fpp-tests-pkg-tool']);
  expect(claims()).toEqual([{ package: 'fpp-tests-pkg-tool', requestedBy: ['fpp-tests-plugin'] }]);
});
