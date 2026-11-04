import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// The Scheduler page's own switch for the whole scheduler.

test.skip(!container, 'edits the settings file inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(async ({ request }) => {
  await request.put('/api/settings/DisableScheduler', { data: '0', headers: { 'Content-Type': 'text/plain' } });
  restoreSettings();
});

test('the Scheduler page has a Disable Scheduler switch that sets DisableScheduler', async ({ page, request }) => {
  // Feature: d59034664 ("Scheduler.php - Add disable Scheduler button").
  // Turning every schedule off took a trip to the settings page, or
  // deactivating each entry; the Scheduler page now draws the
  // DisableScheduler setting (an Advanced one) above its entries.
  setSettingInFile('uiLevel', '1');
  setSettingInFile('DisableScheduler', '0');
  await page.goto('/scheduler.php');
  const box = page.locator('#DisableSchedulerRow input#DisableScheduler');
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(async () => String((await (await request.get('/api/settings/DisableScheduler')).json()).value),
    { timeout: 10_000 }).toBe('1');
  await page.reload();
  await expect(box).toBeChecked();
});
