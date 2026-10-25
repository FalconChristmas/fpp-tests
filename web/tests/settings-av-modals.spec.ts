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
  // Feature: 4338a732d ("pipewire output group config from settings page"):
  // the Audio/Video settings got a button that opens the output groups page
  // in a full-screen dialog, and pipewire-audio.php a ?modal=1 mode that
  // renders the editor alone, without the site's menu and header. Then
  // 6f825cfed: the PipeWire audio settings became a group of their own, and
  // its "modal" setting type renders that button.
  await page.goto('/settings.php#settings-av');
  const button = page.getByRole('button', { name: /Configure (Output )?Audio Groups/ });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const dialog = page.locator('.modal.show');
  await expect(dialog.locator('.modal-dialog')).toHaveClass(/modal-fullscreen/);
  await expect(dialog.locator('iframe')).toHaveAttribute('src', /pipewire-audio\.php\?modal=1/);
  const frame = page.frameLocator('.modal.show iframe');
  await expect(frame.getByRole('button', { name: 'Add Group' }).first()).toBeVisible({ timeout: 15_000 });
  // The page inside is the editor alone, not a second copy of the site.
  await expect(frame.locator('#bodyWrapper'), 'the dialog shows the site menu and header').toHaveCount(0);
  await expect(frame.locator('#platformLogo')).toHaveCount(0);
});
