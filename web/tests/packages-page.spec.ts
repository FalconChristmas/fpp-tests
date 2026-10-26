import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { MEDIA, exists, putFile, readFile } from './settings-file';

// The Package Manager page and the package names behind its search box.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const MANIFEST = `${MEDIA}/config/userpackages.json`;

// Feature: 97ac69f7e ("Package Manager shows package dependencies"). The
// dependencies an install pulled in are counted on their parent's row; a
// package the user cannot remove from here (a plugin's) keeps a disabled
// Uninstall button that says why; each row states its status.
test("the page counts a package's dependencies and says why a plugin's can't be removed", async ({ page }) => {
  const hadManifest = exists(MANIFEST);
  const saved = hadManifest ? readFile(MANIFEST) : '';
  putFile(MANIFEST, JSON.stringify([
    { package: 'fpp-tests-parent', requestedBy: ['user'] },
    { package: 'fpp-tests-dep', requestedBy: ['user'], via: ['fpp-tests-parent'] },
    // Installed on every player, and here claimed by a plugin.
    { package: 'bash', requestedBy: ['fpp-tests-plugin'] },
  ]));
  try {
    await page.goto('/packages.php');
    const table = page.locator('#userPackagesTable');
    const parent = table.locator('tr', { has: page.locator('td.pkg-name', { hasText: 'fpp-tests-parent' }) });
    await expect(parent).toBeVisible({ timeout: 30_000 });
    await expect(parent.locator('td.pkg-name')).toContainText('+1 dependency');
    await expect(parent.locator('td.pkg-status')).toHaveText('Missing');
    await expect(parent.locator('td.pkg-actions button', { hasText: 'Uninstall' })).toBeEnabled();
    // Below the Developer level the dependency is folded into its parent.
    await expect(table.locator('td.pkg-name', { hasText: 'fpp-tests-dep' })).toHaveCount(0);

    const plugins = table.locator('tr', { has: page.locator('td.pkg-name', { hasText: /^bash$/ }) });
    await expect(plugins.locator('td.pkg-status')).toHaveText('Installed');
    const uninstall = plugins.locator('td.pkg-actions button', { hasText: 'Uninstall' });
    await expect(uninstall, "a plugin's package has no Uninstall button").toHaveCount(1);
    await expect(uninstall).toBeDisabled();
    await expect(plugins.locator('td.pkg-actions [title]').first())
      .toHaveAttribute('title', 'Uninstall the plugin that depends on it first: fpp-tests-plugin');
  } finally {
    if (hadManifest) putFile(MANIFEST, saved); else inPlayer('rm', '-f', MANIFEST);
  }
});

// Coverage: b27af40b3 ("stop building the whole apt record set to read one
// field"). The names come from apt's index files (and dpkg's status), once
// each however many versions an index lists, sorted, as JSON.
test('the package name list has each package once', async ({ request }) => {
  const index = '/var/lib/apt/lists/fpp-tests_dists_Packages';
  inPlayer('mkdir', '-p', '/var/lib/apt/lists');
  putFile(index, 'Package: fpp-tests-twice\nVersion: 1\n\nPackage: fpp-tests-twice\nVersion: 2\n\nPackage: fpp-tests-once\nVersion: 1\n');
  try {
    const r = await request.get('/api/system/packages');
    expect(r.headers()['content-type']).toContain('application/json');
    const names: string[] = await r.json();
    expect(names.filter((n) => n === 'fpp-tests-twice')).toHaveLength(1);
    expect(names).toContain('fpp-tests-once');
    // dpkg's own record is read too: an installed package is listed.
    expect(names).toContain('bash');
    expect(names).toEqual([...names].sort());
  } finally {
    inPlayer('rm', '-f', index);
  }
});

// A local apt repository in the player with one package in it, and apt
// pointed at it alone (the image's Debian sources are put aside, so nothing
// is fetched from the internet), for the length of fn.  apt's lists and the
// sources are put back afterwards, and the package removed.
async function withLocalRepo(pkg: string, fn: () => Promise<void>) {
  const repo = '/tmp/fpp-tests-repo';
  inPlayer('sh', '-c', `set -e; rm -rf ${repo}; mkdir -p ${repo}/build/DEBIAN; cd ${repo}
    printf 'Package: ${pkg}\\nVersion: 1.0\\nArchitecture: all\\nMaintainer: fpp-tests <fpp-tests@example.invalid>\\nDescription: fpp-tests stand-in\\n' > build/DEBIAN/control
    dpkg-deb -b build ${pkg}_1.0_all.deb > /dev/null; rm -rf build
    dpkg-scanpackages . /dev/null 2>/dev/null > Packages
    mv /etc/apt/sources.list.d/debian.sources /tmp/fpp-tests-debian.sources
    echo 'deb [trusted=yes] file:${repo} ./' > /etc/apt/sources.list.d/fpp-tests.list`);
  try {
    await fn();
  } finally {
    inPlayer('sh', '-c', `dpkg -P ${pkg} > /dev/null 2>&1; rm -rf ${repo} /etc/apt/sources.list.d/fpp-tests.list
      [ -f /tmp/fpp-tests-debian.sources ] && mv /tmp/fpp-tests-debian.sources /etc/apt/sources.list.d/debian.sources
      find /var/lib/apt/lists -mindepth 1 -maxdepth 1 ! -name lock ! -name partial -exec rm -rf {} +; true`);
  }
}

// Feature: b2b126c10 ("add \"Install All Missing\" button to Package
// Manager").  A manifest carried over from another image lists packages this
// one does not have; the page installs them in one go.  The receiving end is
// apt: the package is installed afterwards.
test('Install All Missing installs the missing packages and skips what apt does not have', async ({ page }) => {
  const hadManifest = exists(MANIFEST);
  const saved = hadManifest ? readFile(MANIFEST) : '';
  const manifest = JSON.stringify([
    { package: 'fpp-tests-parent', requestedBy: ['user'] },
    // Comes back with its parent; not one of the missing.
    { package: 'fpp-tests-dep', requestedBy: ['user'], via: ['fpp-tests-parent'] },
    { package: 'bash', requestedBy: ['user'] },
    { package: 'fpp-tests-gone', requestedBy: ['user'] },
  ]);
  putFile(MANIFEST, manifest);
  const installed = () => inPlayer('sh', '-c', "dpkg-query -W -f='${db:Status-Status}' fpp-tests-parent 2>/dev/null; true").trim();
  try {
    await withLocalRepo('fpp-tests-parent', async () => {
      expect(installed(), 'the control: the package is not installed yet').not.toBe('installed');
      await page.goto('/packages.php');
      const button = page.locator('#installMissingBtn');
      await expect(button).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('#installMissingCount')).toHaveText('2');
      // (In the order the page's status requests came back.)
      expect((await button.getAttribute('title'))!.split(', ').sort()).toEqual(['fpp-tests-gone', 'fpp-tests-parent']);
      page.once('dialog', (d) => d.accept());
      await button.click();
      const log = page.locator('#packageProgressPopupText');
      await expect(log).toHaveValue(/Completed with skipped packages/, { timeout: 180_000 });
      expect(await log.inputValue()).toContain("Skipping 'fpp-tests-gone'");
      expect(installed(), 'apt did not install the missing package').toBe('installed');
      // The manifest is what it was.
      expect(JSON.parse(readFile(MANIFEST))).toEqual(JSON.parse(manifest));
    });
  } finally {
    if (hadManifest) putFile(MANIFEST, saved); else inPlayer('rm', '-f', MANIFEST);
  }
});
