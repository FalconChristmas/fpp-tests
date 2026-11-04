import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Email tab shows the settings that hang off the SMTP server (port, user,
// password, from and to addresses) for any server name, and hide them when there is none.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

test('the port, user and address settings show whatever the SMTP server is', async ({ page }) => {
  // Regression: 5da3b459f.  The server's children were a list keyed by one
  // server name; they are now {"*": [...]} so any server shows them.
  const restore = snapshotSettings();
  try {
    setSettingInFile('uiLevel', '1');
    setSettingInFile('emailserver', '');
    await page.goto('/settings.php#settings-email');
    await page.locator('#settingsManagerTabs').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('#settings-email-tab').click();
    const server = page.locator('#emailserver');
    await expect(server).toBeVisible();
    for (const name of ['smtp.example.com', 'mail.other.net', 'localhost']) {
      await server.fill(name);
      await server.press('Tab');
      for (const kid of ['emailport', 'emailuser', 'emailpass', 'emailfromuser', 'emailtoemail', 'emailfromtext']) {
        await expect(page.locator(`#${kid}`), `${kid} with the server "${name}"`).toBeVisible();
      }
    }
    // and with no server named they are not offered
    await server.fill('');
    await server.press('Tab');
    await expect(page.locator('#emailport')).toBeHidden();
  } finally {
    restore();
  }
});
