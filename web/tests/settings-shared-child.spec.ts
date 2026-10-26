import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// Regression: deafb0dd1 ("show a settings child listed under more than one
// parent value").  Distributed Compile lists Compile Hosts (DistccHosts) as a
// child of both its 'distcc' and 'nocc' values.  The generated
// UpdateDistributedCompileChildren() had one if/else per value, so whichever
// value didn't match marked the row hidden, and the page-load show pass then
// never showed it: after a reload Compile Hosts was gone in both modes.  The
// settings are at the Developer UI level.

test.skip(!container, 'sets the settings file inside the run-web.sh container');

async function developerTab(page: Page) {
  await page.goto(`/settings.php?fpp-tests=${Date.now()}#settings-developer`);
  await page.click('#settings-developer-tab');
  await expect(page.locator('#DistributedCompileRow')).toBeVisible();
}

for (const mode of ['distcc', 'nocc']) {
  test(`Compile Hosts is shown after a reload with Distributed Compile set to ${mode}`, async ({ page }) => {
    await keepingSettings(async () => {
      setSettingInFile('uiLevel', '3');
      setSettingInFile('DistributedCompile', mode);
      await developerTab(page);
      await expect(page.locator('#DistccHostsRow')).toBeVisible();

      // The control: with it off the row is hidden.
      setSettingInFile('DistributedCompile', 'off');
      await developerTab(page);
      await expect(page.locator('#DistccHostsRow')).toBeHidden();
    });
  });
}

test('changing Distributed Compile shows Compile Hosts for both distcc and nocc', async ({ page }) => {
  await keepingSettings(async () => {
    setSettingInFile('uiLevel', '3');
    setSettingInFile('DistributedCompile', 'off');
    // Saves are swallowed; the select's onChange shows and hides the rows.
    await page.route((u) => u.pathname.endsWith('/api/settings/DistributedCompile'),
      (route) => route.request().method() === 'GET' ? route.continue() : route.fulfill({ json: { status: 'OK' } }));
    await developerTab(page);
    for (const [mode, shown] of [['distcc', true], ['off', false], ['nocc', true], ['off', false]] as const) {
      await page.selectOption('#DistributedCompile', mode);
      if (shown) await expect(page.locator('#DistccHostsRow'), mode).toBeVisible();
      else await expect(page.locator('#DistccHostsRow'), mode).toBeHidden();
    }
  });
});
