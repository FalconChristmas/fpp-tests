import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container } from './container';
import { CONFIG, cleanupPipeWire, readFile, writeFile } from './pw-helpers';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Regression: 83dfa1e33 ("add unsaved changes handling and notification for
// input and video configurations").  Deleting the last PipeWire output group
// (or input group) left the page with only "Create First Group": the toolbar
// with Save went away with the last group, so the deletion could never be
// saved, and the group came back on the next load.  Now the page says the
// change isn't saved, keeps Save, and saving writes it.  The receiving end is
// the saved config file the API writes, and the page loaded again.

test.skip(!container, 'seeds config files inside the run-web.sh container');

let restoreSettings: () => void;
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  setSettingInFile('MediaBackend', 'pipewire');
});
test.afterEach(() => {
  cleanupPipeWire();
  restoreSettings();
});

async function deleteLastAndSave(page: Page, path: string, del: string, save: string, file: string, key: string) {
  page.on('dialog', (d) => d.accept());
  await page.goto(path);
  await expect(page.locator('#bottomToolbar')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(del);
  await expect(page.locator('#unsavedChangesBanner'), 'no unsaved-changes notice').toBeVisible();
  const button = page.locator(`#bottomToolbar button[onclick="${save}()"]`);
  await expect(button, 'nothing left to save the deletion with').toBeVisible();
  const saved = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/api/pipewire/audio/'));
  await button.click();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#unsavedChangesBanner')).toHaveCount(0);
  expect(JSON.parse(readFile(`${CONFIG}/${file}`))[key]).toEqual([]);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#bottomToolbar')).toBeHidden();
}

test('deleting the last output group can be saved', async ({ page }) => {
  writeFile(`${CONFIG}/pipewire-audio-groups.json`, {
    groups: [{ id: 1, name: 'fpp-tests Only', enabled: true, channels: 2, members: [] }],
  });
  await deleteLastAndSave(page, '/pipewire-audio.php', 'DeleteGroup(0)', 'SaveGroups', 'pipewire-audio-groups.json', 'groups');
});

test('deleting the last input group can be saved', async ({ page }) => {
  writeFile(`${CONFIG}/pipewire-input-groups.json`, {
    inputGroups: [{ id: 1, name: 'fpp-tests Bus', enabled: true, channels: 2, outputs: [], members: [] }],
  });
  await deleteLastAndSave(page, '/pipewire-input-mixing.php', 'RemoveGroup(0)', 'SaveInputGroups',
    'pipewire-input-groups.json', 'inputGroups');
});
