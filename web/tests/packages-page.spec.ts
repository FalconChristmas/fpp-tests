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
