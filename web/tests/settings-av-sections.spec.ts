import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Covers 6a784d026 ("improve initial visibility handling for audio
// sections in settings"). The Audio/Video tab is loaded into the Settings
// page after it, and its script that shows the sections for the Media
// Backend -- and puts back the Audio Output and Video Output rows, which the
// backend's child-settings logic hides in Simple mode -- only ran at
// document-ready, after the page had already applied that logic. In Simple
// mode, the default, the tab came up without its Audio Output control until
// the backend was changed and changed back. It now runs as the tab loads.
//
// Checked on first paint, with no change event, for both backends. This
// passes on the fix's parent too (and on a revert on master): in this
// browser the tab's document-ready handler still runs before the first
// check, so the late wrapper never shows. It covers the visibility, not the
// ordering the fix changed.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('the Audio/Video tab shows the Simple sections and the Audio Output control on load', async ({ page }) => {
  setSettingInFile('MediaBackend', 'pipewire-simple');
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire-simple', { timeout: 15_000 });
  await expect(page.locator('#pipeWireSection')).toBeHidden();
  await expect(page.locator('#AudioOutputRow'), 'the Audio Output control is hidden in Simple mode').toBeVisible();
  await expect(page.locator('#AudioOutput')).toBeVisible();
});

test('the Audio/Video tab shows the PipeWire sections on load in Advanced mode', async ({ page }) => {
  setSettingInFile('MediaBackend', 'pipewire');
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire', { timeout: 15_000 });
  await expect(page.locator('#pipeWireSection')).toBeVisible();
});
