import { test, expect } from './fixtures';

// The File Manager loads each tab's list from api/files/<dir>.  When the
// list can't be loaded it says so, naming the directory.

test('a file list that fails to load is reported by the directory it was for', async ({ page }) => {
  // Regression: 6f6f57be0.  GetFiles(dir) is shared by every tab but its
  // error said "Load Sequences: Error loading list of sequences", whatever
  // the tab.
  await page.route((u) => u.pathname === '/api/files/Images', (route) => route.fulfill({ status: 500, body: 'no' }));
  await page.goto('/filemanager.php');
  const dialog = page.locator('.ui-dialog, .modal.show').filter({ hasText: 'Error loading list of' });
  await expect(dialog.first()).toBeVisible({ timeout: 15_000 });
  await expect(dialog.first()).toContainText('Load Files');
  await expect(dialog.first()).toContainText('Error loading list of files in Images directory');
  await expect(dialog.first()).not.toContainText('sequences');
});
