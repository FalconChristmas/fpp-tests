import { test, expect } from './fixtures';

// Regression: 54aec03ee ("Fix Docker check on storage settings screen").
// The Storage tab hides the Storage Device select and its format/flash
// controls when the player is a Docker container, but tested SubPlatform
// (empty there) instead of Platform, so a container offered to repartition
// a "device" that does not exist.

test('the Storage tab offers no storage device select in a container', async ({ request }) => {
  const html = await (await request.get('/settings-storage.php')).text();
  // The control: the tab is there, with its always-present content.
  expect(html).toContain('Mounted USB Device Actions');
  expect(html, 'the Storage Device select printed in a container').not.toContain('id=\'storageDevice\'');
  expect(html).not.toContain('Storage Device:');
});
