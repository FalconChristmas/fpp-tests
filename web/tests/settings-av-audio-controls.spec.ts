import { test, expect } from './fixtures';
import { container } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Covers a67486841 (the settings page half; the boot half -- folding a
// stored bit-depth AudioFormat onto its rate -- is in
// scenarios/test_audio_boot_cards.py). The Audio/Video tab offered
// AudioLayout, read only by the deleted SDL output, and AudioBufferSize,
// read only by the retired ALSA backend's asoundrc, and AudioFormat as
// rate/bit-depth pairs when only the rate is used. Now neither of the two
// is on the page, and AudioFormat lists only the rates: 1 (44100), 4
// (48000), 7 (96000), besides the default.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(() => restoreSettings());

test('the Audio/Video tab offers no audio settings that do nothing', async ({ page }) => {
  setSettingInFile('MediaBackend', 'pipewire-simple');
  setSettingInFile('uiLevel', '1');  // they are Advanced settings
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire-simple', { timeout: 15_000 });
  // The setting the section keeps, so the section itself is there.
  await expect(page.locator('#AudioPeriodSize')).toBeVisible();
  await expect(page.locator('#AudioLayout'), 'AudioLayout is still offered').toHaveCount(0);
  await expect(page.locator('#AudioBufferSize'), 'AudioBufferSize is still offered').toHaveCount(0);
  const values = await page.locator('#AudioFormat option').evaluateAll(
    (opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(values.filter((v) => v !== '0').sort(), 'AudioFormat options').toEqual(['1', '4', '7']);
});
