import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The older Health Check page (healthCheck.php, still a landing page choice):
// scripts/healthCheck --php run by healthCheckHelper.php, one row per check
// whose status the script fills in as it goes.

// The status cell of the check with this description, once it has one.
async function verdict(page: Page, description: string) {
  const row = page.locator('#healthCheckOutput .row', { has: page.locator('.description', { hasText: description }) });
  const status = row.locator('[id^="checkNumber"]');
  await expect(status).not.toHaveText('Running...', { timeout: 120_000 });
  return status;
}

for (const { shift, icon, text } of [
  { shift: 0, icon: 'text-success', text: '' },
  { shift: 60 * 60, icon: 'text-warning', text: 'more than 10 mins different to the browser' },
  { shift: 6 * 60 * 60, icon: 'text-danger', text: 'significantly different to the browser' },
]) {
  test(`the date check compares the player's clock with the browser's ${shift / 3600} hours ahead`, async ({ page }) => {
    // Feature: dc536c0d3.  The page sends the browser's time and the script
    // checks the player's against it: a warning past 10 minutes, a failure
    // past 4 hours.  A player without a clock source keeps the wrong time.
    test.setTimeout(180_000);
    await page.clock.install({ time: new Date(Date.now() + shift * 1000) });
    const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/healthCheckHelper.php');
    await page.goto('/healthCheck.php');
    const asked = Number(new URL((await sent).url()).searchParams.get('timestamp'));
    expect(Math.abs(asked - (Date.now() / 1000 + shift))).toBeLessThan(120);
    const status = await verdict(page, 'FPP Date/Time Alignment to Browser');
    await expect(status.locator(`i.${icon}`)).toHaveCount(1);
    if (text) await expect(status).toContainText(text);
    // The page's own Restart button comes back when the run is done.
    await expect(page.locator('#btnStartHealthCheck')).not.toHaveClass(/disabled/, { timeout: 120_000 });
  });
}

test.describe('with unpartitioned space on the card', () => {
  test.skip(!container, 'sets UnpartitionedSpace in the settings file inside the run-web.sh container');

  for (const path of ['/index.php', '/healthCheck.php']) {
    test(`${path}'s notice links to the Storage settings tab`, async ({ page }) => {
      // Also 4c40f3916, which made the link settings.php#settings-storage
      // (it was settings.php?tab=Storage).  Since 32272055e, which stopped
      // fpp.js showing the first tab over the one ?tab= marked, the old link
      // opens Storage too, so this no longer tells the two apart.
      await keepingSettings(async () => {
        setSettingInFile('UnpartitionedSpace', '1000000000');
        await page.goto(path);
        const link = page.locator('.alert-danger a', { hasText: 'Storage Settings' });
        await expect(link).toBeVisible();
        await link.click();
        await expect(page).toHaveURL(/\/settings\.php/);
        await expect(page.locator('#settings-storage-tab')).toHaveClass(/active/);
        await expect(page.locator('#settings-storage')).toBeVisible();
      });
    });
  }
});
