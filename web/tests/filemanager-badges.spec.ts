import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { container, inPlayer } from './container';

// The Items and Size badges over each File Manager table: how many files
// the table shows and how much they add up to, counting only the rows a
// filter leaves.  Two files of known sizes are put in the player's music
// directory; the whole listing is whatever api/files/music says is there.

test.skip(!container, 'seeds files inside the run-web.sh container');

const MUSIC = '/home/fpp/media/music';
const A = 'fpp-tests-badge-a.mp3'; // 1000 bytes
const B = 'fpp-tests-badge-b.mp3'; // 3000 bytes

// formatBytes() in js/fpp-filemanager.js.
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

async function setSetting(request: APIRequestContext, name: string, value: string) {
  expect((await request.put(`/api/settings/${name}`, { data: value })).ok()).toBe(true);
}

async function filterNames(page: Page, text: string) {
  const input = page.locator('#tab-audio .bootstrap-table thead th[data-field="filename"] .filter-control input').locator('visible=true').first();
  await input.fill(text);
  await input.press('Enter');
}

test.beforeEach(async ({ request }) => {
  inPlayer('sh', '-c', `head -c 1000 /dev/zero > ${MUSIC}/${A}; head -c 3000 /dev/zero > ${MUSIC}/${B}`);
  await setSetting(request, 'fileManagerTableFilter', '1');
});

test.afterEach(async ({ request }) => {
  inPlayer('rm', '-f', `${MUSIC}/${A}`, `${MUSIC}/${B}`);
  await setSetting(request, 'fileManagerTableFilter', '0');
});

test('the Items and Size badges count the rows the table shows', async ({ page, request }) => {
  // Regression: e551c1d18.  UpdateFileCount() put the jQuery row set itself
  // in the Items badge and then used a variable it never set, so it threw
  // before the count or size was written.
  // Feature: ee5291ba7 (the Size badge, the visible files' sizes summed).
  const files = (await (await request.get('/api/files/music')).json()).files as any[];
  const total = files.reduce((n, f) => n + (parseInt(f.sizeBytes) || 0), 0);
  // The control: the listing has the test's files at their sizes.
  expect(files.find((f) => f.name === A)?.sizeBytes).toBe(1000);
  expect(files.find((f) => f.name === B)?.sizeBytes).toBe(3000);

  await page.goto('/filemanager.php#tab-audio');
  await page.locator('#tab-audio-tab').click();
  await expect(page.locator('#tblMusic tbody tr').filter({ hasText: B })).toHaveCount(1);
  await expect(page.locator('#fileCount_Music')).toHaveText(String(files.length));
  await expect(page.locator('#fileSize_Music')).toHaveText(formatBytes(total));

  await filterNames(page, 'fpp-tests-badge');
  await expect(page.locator('#tblMusic tbody tr:visible')).toHaveCount(2);
  await expect(page.locator('#fileCount_Music')).toHaveText('2');
  await expect(page.locator('#fileSize_Music')).toHaveText(formatBytes(4000));

  await filterNames(page, 'fpp-tests-badge-b');
  await expect(page.locator('#tblMusic tbody tr:visible')).toHaveCount(1);
  await expect(page.locator('#fileCount_Music')).toHaveText('1');
  await expect(page.locator('#fileSize_Music')).toHaveText(formatBytes(3000));
});
