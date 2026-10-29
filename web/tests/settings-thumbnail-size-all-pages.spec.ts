import { test, expect } from './fixtures';
import { container } from './container';
import { keepingSettings, setSettingInFile } from './privacy-helpers';

// fileManagerThumbnailSize is read by fpp.js's shared file-list code
// (GetFiles builds the Images table with thumbnails of that size), not only
// by the File Manager's own script, so settings.json exposes it to every page
// ("all") as well as to filemanager.  The receiving end is window.settings as
// a page other than the File Manager has it.

test.skip(!container, 'writes the settings file inside the run-web.sh container');

test('the thumbnail size reaches pages other than the File Manager', async ({ page }) => {
  // Regression: 2dd12eda2.  It was exposed to the filemanager page only, so
  // fpp.js's file lists on any other page saw no thumbnail size and showed
  // no thumbnails.  (The same commit's playlistAutoScroll change is the bug
  // settings-js-exposure.spec.ts's "the status page gets playlistAutoScroll"
  // keeps failing on.)
  await keepingSettings(async () => {
    setSettingInFile('fileManagerThumbnailSize', '125');
    for (const path of ['/index.php', '/settings.php', '/filemanager.php']) {
      await page.goto(path);
      const v = await page.evaluate(() => (window as any).settings?.fileManagerThumbnailSize);
      expect(v, `fileManagerThumbnailSize on ${path}`).toBe('125');
    }
  });
});
