import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings } from './privacy-helpers';

// Backups > File Copy: picking the remote host's USB device saves the choice
// as the backup.RemoteStorage setting, through the settings API.

test.skip(!container, 'changes the player\'s settings file inside the run-web.sh container');

test('picking the remote host\'s storage device saves it as the backup.RemoteStorage setting', async ({ page, request }) => {
  // Regression: 2d2cb15f2.  The page sent the choice as part of the URL
  // (api/settings/backup.RemoteStorage/<device>), which the settings API has
  // no route for: the page said "Failed to save Backup Storage" and nothing
  // was saved.
  await keepingSettings(async () => {
    await page.route((u) => u.pathname.includes('/api/backups/list'), (route) => route.fulfill({ json: ['/'] }));
    await page.goto('/backup.php');
    await page.click('#backups-fileCopy-tab');
    await page.waitForLoadState('networkidle');
    const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/api/settings/backup.RemoteStorage'));
    // The select is shown only for a remote host; the choice is made the way
    // the page's own onchange sees it.
    await page.evaluate(() => {
      const sel = document.getElementById('backup.RemoteStorage') as HTMLSelectElement;
      sel.add(new Option('sda1 (fpp-tests)', 'sda1'));
      sel.value = 'sda1';
      sel.dispatchEvent(new Event('change'));
    });
    const sent = await put;
    expect(sent.postData(), 'the device goes in the body').toBe('sda1');
    await expect(page.locator('.jGrowl-message, .jGrowl-notification').filter({ hasText: 'Remote Backup Storage saved' }).first()).toBeVisible({ timeout: 10_000 });
    // The receiving end: the settings API now answers with it.
    const saved = await (await request.get('/api/settings/backup.RemoteStorage')).json();
    expect(saved.value).toBe('sda1');
  });
});
