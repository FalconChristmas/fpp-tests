import { test, expect } from './fixtures';
import { container } from './container';
import { settingInFile, setSettingInFile } from './settings-file';

// The PipeWire Video Input Sources page reached from the Audio/Video
// settings: a "modal" setting is a button that opens its page full-screen in
// a dialog, with ?modal=1 asking the page to draw its editor alone.

test.skip(!container, 'sets the media backend in the settings file inside the run-web.sh container');

const KEYS = ['MediaBackend', 'AudioBackend'];
let saved: (string | undefined)[] = [];
test.beforeEach(() => {
  saved = KEYS.map(settingInFile);
  for (const k of KEYS) setSettingInFile(k, 'pipewire');
});
test.afterEach(() => KEYS.forEach((k, i) => setSettingInFile(k, saved[i])));

test('the video input sources open from the Audio/Video settings in a dialog, without the site menu', async ({ page }) => {
  // Regression: bfc6ab220.  The page had no modal mode: in the settings
  // dialog it carried a second copy of the site's menu and header around
  // the editor, and a link back to the settings page it was opened from.
  await page.goto('/settings.php#settings-av');
  const button = page.getByRole('button', { name: 'Configure Video Input Sources' });
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
  const dialog = page.locator('.modal.show');
  await expect(dialog.locator('iframe')).toHaveAttribute('src', /pipewire-video-inputs\.php\?modal=1/);
  const frame = page.frameLocator('.modal.show iframe');
  await expect(frame.getByRole('button', { name: 'Add Source' })).toBeVisible({ timeout: 15_000 });
  await expect(frame.locator('#bodyWrapper'), 'the dialog shows the site menu and header').toHaveCount(0);
  await expect(frame.locator('#platformLogo')).toHaveCount(0);
  await expect(frame.getByRole('link', { name: /Pipewire Settings/ }), 'a link back to the page it was opened from').toHaveCount(0);
  await expect(frame.locator('body')).toHaveClass(/modal-mode/);

  // The control: opened on its own the page keeps its menu and the link.
  await page.goto('/pipewire-video-inputs.php');
  await expect(page.locator('#bodyWrapper')).toHaveCount(1);
  await expect(page.getByRole('link', { name: /Pipewire Settings/ })).toBeVisible();
});
