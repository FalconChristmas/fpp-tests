import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { settleAfterApply } from './pipewire-conf';
import { MEDIA, exists, putFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Feature: 7a7b59cb2 ("add media backend to options in fpp reset"). Reset FPP
// Config had no way back from an Advanced (Full PipeWire) setup short of
// resetting all the settings: the output and input groups, AES67 and Opus
// streams stayed in the media directory, and MediaBackend stayed on the full
// stack. The Reset dialog on the System settings tab now has an "Audio
// Backend (PipeWire)" area that removes those configs, puts MediaBackend back
// to Simple and clears the PipeWire sink choices -- and leaves everything
// else alone. (pw-vban.spec.ts checks the VBAN files this area later took in.)
//
// The receiving end is the settings API and the Settings page reading the
// backend back as Simple. The reset also restarts PipeWire and fppd; the
// container has no PipeWire service, so that is not checked.

test.skip(!container, 'needs the player run-web.sh serves (FPP_TESTS_WEB_CONTAINER)');

const CONFIG = `${MEDIA}/config`;
const PW_FILES = ['pipewire-audio-groups.json', 'pipewire-input-groups.json', 'pipewire-aes67-instances.json',
  'pipewire-opus-rtp-instances.json', 'pipewire-video-groups.json'];
// Not the audio backend's: a reset of it must leave this.
const OTHER = 'fpp-tests-reset-other.json';

let restoreSettings: () => void;
test.beforeEach(() => { restoreSettings = snapshotSettings(); });
test.afterEach(async ({ request }) => {
  inPlayer('sh', '-c', `cd ${CONFIG} && rm -f ${[...PW_FILES, OTHER].join(' ')}`);
  restoreSettings();
  await settleAfterApply(request);
});

test('Reset FPP Config resets the audio backend and nothing else', async ({ page, request }) => {
  test.setTimeout(120_000);
  for (const f of [...PW_FILES, OTHER]) putFile(`${CONFIG}/${f}`, '{"fpp-tests": true}\n');
  setSettingInFile('MediaBackend', 'pipewire');
  setSettingInFile('PipeWireSinkName', 'fpp_group_fpp_tests');
  setSettingInFile('AES67Enabled', '1');
  setSettingInFile('HostDescription', 'fpp-tests-reset-keeps');
  setSettingInFile('uiLevel', '1');

  await page.goto('/settings.php#settings-system');
  await page.click('input[value="Reset FPP Config"]');
  await expect(page.locator('#resetFPPDialog')).toBeVisible();
  await page.click('#resetFPPDialog #noneButton');
  await page.check('#rc_audiobackend');
  page.once('dialog', (d) => d.accept());
  const sent = page.waitForRequest((r) => r.url().includes('resetConfig.php'));
  await page.click('#resetFPPDialog button:has-text("Reset")');
  const areas = new URL((await sent).url()).searchParams.get('areas')!.split(',').filter((a) => a !== 'dummy');
  expect(areas).toEqual(['audiobackend']);
  await expect(page.locator('#doResetFPPConfigDialogCloseButton')).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('#resetConfigText')).toHaveValue(/Area: audiobackend/);

  for (const f of PW_FILES) expect(exists(`${CONFIG}/${f}`), `${f} was not removed`).toBe(false);
  expect(settingInFile('MediaBackend'), 'the backend was not put back to Simple').toBe('pipewire-simple');
  expect(settingInFile('PipeWireSinkName'), 'the PipeWire sink choice was kept').toBeUndefined();
  expect(settingInFile('AES67Enabled')).toBeUndefined();
  // The control: nothing else was reset.
  expect(exists(`${CONFIG}/${OTHER}`), 'a file of another area was removed').toBe(true);
  expect(settingInFile('HostDescription')).toBe('fpp-tests-reset-keeps');

  await settleAfterApply(request);
  expect((await (await request.get('/api/settings/MediaBackend')).json()).value).toBe('pipewire-simple');
  await page.goto('/settings.php?tab=AV');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire-simple', { timeout: 15_000 });
});
