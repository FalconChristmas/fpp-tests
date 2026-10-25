import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Regression: 9be2f1c6e ("force reboot if media backend changed"). Changing
// the Media Backend on the Settings page asked for nothing, although the
// change only fully takes effect at the next boot (fppinit sets the audio
// stack up for the backend then): the player carried on half in the old mode
// with no prompt. MediaBackend is now declared reboot: 1 in settings.json, so
// the page raises the reboot flag when it is saved.
//
// What is checked is the flag the page stores and the Reboot Required alert
// it shows from it. The backend change itself is answered here and never
// reaches the player: what PHP does with a new backend is
// pw-media-backend.spec.ts's business, and needs stand-ins for fppinit and
// systemctl.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('changing the Media Backend asks for a reboot', async ({ page, request }) => {
  setSettingInFile('rebootFlag', '0');
  setSettingInFile('restartFlag', '0');
  setSettingInFile('MediaBackend', 'pipewire-simple');
  await page.route((u) => u.pathname.endsWith('/api/settings/MediaBackend'), (route) =>
    route.request().method() === 'PUT' ? route.fulfill({ json: { status: 'OK' } }) : route.continue());
  page.on('dialog', (d) => d.accept());

  await page.goto('/settings.php?tab=AV');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire-simple', { timeout: 15_000 });
  await expect(page.locator('#rebootFlag')).toBeHidden();
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/settings/MediaBackend'));
  await page.selectOption('#MediaBackend', 'pipewire');
  // The control: the page saved the change.
  expect((await saved).postData()).toBe('pipewire');

  await expect(page.locator('#rebootFlag'), 'the page shows no Reboot Required alert').toBeVisible({ timeout: 15_000 });
  await expect.poll(() => settingInFile('rebootFlag'), { message: 'the reboot flag was not stored' }).toBe('1');
  expect((await (await request.get('/api/system/status')).json()).rebootFlag).toBe(1);
});
