import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// The dialog that asks before a crash report is sent (File Manager > Logs,
// and the Diagnostic Report wizard): it names the recipients and what the
// report includes in Settings > Privacy's own words, from
// GET /api/crashes/disclosures.  The test opens it as the pages do,
// UploadAndDeleteCrashReports(), and only reads it: nothing is sent.

test.skip(!container, 'changes the settings file inside the run-web.sh container');

async function dialogText(page: import('@playwright/test').Page) {
  await page.goto('/index.php');
  await page.evaluate(() => (window as any).UploadAndDeleteCrashReports(['2026-01-01-fpp-tests.zip'], { showResults: false }));
  const dlg = page.locator('#confirmUploadCrash');
  await expect(dlg).toBeVisible();
  // The (?) of every item the report includes.
  const help = await dlg.locator('.crashDisclosureHelp').count();
  return { text: await dlg.innerText(), help };
}

test('the send dialog names the recipients and what the report includes as Settings > Privacy does', async ({ page }) => {
  // Feature: b6b8a9c6e.  The dialog said "to the FPP developers" and
  // described the contents in its own words; it now takes both from the
  // privacy table (/api/crashes/disclosures), with the e-mail address listed
  // only when one is set.
  await keepingSettings(async () => {
    setSettingInFile('emailAddress', '');
    const without = await dialogText(page);
    expect(without.text).toContain('Send the following crash report to FPP & xLights developers and AI service');
    expect(without.text).toMatch(/It includes: crash reports\s*,\s*your settings\s*,\s*configuration and logs\s*\./);
    expect(without.text).not.toContain('e-mail address');
    expect(without.help, 'a (?) for each item').toBe(3);
    setSettingInFile('emailAddress', 'fpp-tests@example.invalid');
    const withMail = await dialogText(page);
    expect(withMail.text).toMatch(/configuration and logs\s*,\s*e-mail address\s*\./);
    expect(withMail.help).toBe(4);
  });
});
