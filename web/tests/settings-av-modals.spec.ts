import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, setSettingInFile } from './settings-file';

// The PipeWire pages reached from the Audio/Video settings: a "modal"
// setting is a button that opens its page full-screen in a dialog.

test.skip(!container, 'sets the media backend in the settings file inside the run-web.sh container');

// MediaBackend, which was AudioBackend before the media backends were split.
const KEYS = ['MediaBackend', 'AudioBackend'];
let saved: (string | undefined)[] = [];
test.beforeEach(() => {
  saved = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
});
test.afterEach(() => KEYS.forEach((k, i) => setSettingInFile(k, saved[i])));

test('the audio output groups open from the Audio/Video settings in a dialog', async ({ page }) => {
  // Feature: 6f825cfed. The PipeWire audio settings became a group of their
  // own, and its "modal" setting type renders a button that opens the audio
  // output groups page (pipewire-audio.php?modal=1) in a full-screen dialog.
  await page.goto('/settings.php#settings-av');
  const button = page.getByRole('button', { name: /Configure (Output )?Audio Groups/ });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const dialog = page.locator('.modal.show');
  await expect(dialog.locator('.modal-dialog')).toHaveClass(/modal-fullscreen/);
  await expect(dialog.locator('iframe')).toHaveAttribute('src', /pipewire-audio\.php\?modal=1/);
  await expect(page.frameLocator('.modal.show iframe').getByRole('button', { name: 'Add Group' }).first()).toBeVisible({ timeout: 15_000 });
});
