import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { putFile, snapshotSettings, setSettingInFile } from './settings-file';

// The BeagleBone HDMI settings (Enable HDMI Display, Force HDMI Resolution):
// which BeagleBone models are offered them, and what saving them does to
// uEnv.txt in the boot directory.  The board is /etc/fpp/platform plus a
// device tree model, which the container does not have, so php-fpm runs
// with scenarios/fakesys.c preloaded to serve /proc/device-tree/model from a
// file the spec writes.

test.skip(!container, 'changes the platform, php-fpm and the boot files inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const MODEL = '/tmp/fpp-tests-bbb-model';
const SO = '/tmp/fpp-tests-fakesys.so';
const BOOT = inPlayer('sh', '-c', '[ -d /boot/firmware ] && echo /boot/firmware || echo /boot').trim();
const UENV = `${BOOT}/uEnv.txt`;

function restartPhpFpm(env: string) {
  inPlayer('sh', '-c',
    'm=$(cat /run/php/php8.4-fpm.pid 2>/dev/null); [ -n "$m" ] && kill -QUIT "$m"; ' +
    'for i in $(seq 50); do pgrep -x php-fpm8.4 > /dev/null || break; sleep 0.1; done; ' +
    `${env} php-fpm8.4 -R && ` +
    'for i in $(seq 50); do [ -S /run/php/php8.4-fpm.sock ] && break; sleep 0.1; done');
}
function asModel(model: string) {
  putFile(MODEL, `${model}\0`);
}
const uenv = () => inPlayer('sh', '-c', `cat ${UENV}`);

let savedPlatform = '';
let savedUenv: string | null = null;
let restoreSettings: (() => void) | undefined;
test.beforeAll(() => {
  inPlayer('gcc', '-O2', '-shared', '-fPIC', '-o', SO, '/tests/scenarios/fakesys.c', '-ldl');
  asModel('TI AM335x BeagleBone Black');
  restartPhpFpm(`LD_PRELOAD=${SO} FAKESYS=/proc/device-tree/model=${MODEL}:/sys/firmware/devicetree/base/model=${MODEL}`);
});
test.afterAll(() => {
  restartPhpFpm('');
  inPlayer('rm', '-f', SO, MODEL);
});
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
  const out = inPlayer('sh', '-c', `if [ -e ${UENV} ]; then echo yes; cat ${UENV}; else echo no; fi`);
  savedUenv = out.startsWith('yes\n') ? out.slice(4) : null;
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' 'BeagleBone Black' > ${PLATFORM}`);
  putFile(UENV, '#disable_uboot_overlay_video=1\nuname_r=6.1.0\ncmdline=coherent_pool=1M quiet\n');
  inPlayer('chmod', '644', UENV);
});
test.afterEach(() => {
  restoreSettings?.();
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (savedUenv === null) inPlayer('rm', '-f', UENV); else putFile(UENV, savedUenv);
});

test('Enable HDMI Display is offered on a BeagleBone Black and not on a PocketBeagle', async ({ page }) => {
  // Feature: 92a7c9f80.  A setting's "variants" list keys on the board's
  // Variant: the BeagleBone Black models get Enable HDMI Display (and, once it
  // is on, the Force HDMI Resolution it parents); other Beagle boards do not.
  setSettingInFile('MediaBackend', 'pipewire');
  setSettingInFile('EnableBBBHDMI', '1');
  setSettingInFile('uiLevel', '1'); // Enable HDMI Display is an Advanced setting
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire', { timeout: 15_000 });
  await expect(page.locator('#EnableBBBHDMIRow')).toBeVisible();
  await expect(page.locator('#ForceHDMIResolutionRow')).toBeVisible();

  asModel('BeagleBoard.org PocketBeagle');
  await page.reload(); // the same URL, so a goto would not load it again
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire', { timeout: 15_000 });
  await expect(page.locator('#EnableBBBHDMIRow')).toHaveCount(0);
  await expect(page.locator('#ForceHDMIResolutionRow')).toHaveCount(0);
});

test('saving Force HDMI Resolution and Enable HDMI Display edits uEnv.txt', async ({ request }) => {
  // Feature: 92a7c9f80.  On a BeagleBone the resolution is a video=HDMI-A-1
  // token on the cmdline line of uEnv.txt (replaced, and removed by Default),
  // and Enable HDMI Display comments out disable_uboot_overlay_video.
  let r = await request.put('/api/settings/ForceHDMIResolution', { data: '1920x1080@60' });
  expect(r.ok(), await r.text()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^cmdline=.* video=HDMI-A-1:1920x1080@60$/m);
  r = await request.put('/api/settings/ForceHDMIResolution', { data: '1280x720@60' });
  expect(r.ok()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^cmdline=.* video=HDMI-A-1:1280x720@60$/m);
  expect(uenv().match(/video=HDMI-A-1/g)).toHaveLength(1);
  r = await request.put('/api/settings/ForceHDMIResolution', { data: 'Default' });
  expect(r.ok()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).not.toContain('video=HDMI-A-1');
  expect(uenv()).toMatch(/^cmdline=coherent_pool=1M quiet$/m);

  // starts commented; Enable un-comments it, Disable puts the comment back
  putFile(UENV, 'disable_uboot_overlay_video=1\ncmdline=quiet\n');
  r = await request.put('/api/settings/EnableBBBHDMI', { data: '1' });
  expect(r.ok()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^#disable_uboot_overlay_video=1$/m);
  r = await request.put('/api/settings/EnableBBBHDMI', { data: '0' });
  expect(r.ok()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^disable_uboot_overlay_video=1$/m);
});

test('Force HDMI Mode Timing reaches the uEnv.txt video= mode too', async ({ request }) => {
  // Feature: 0a870c197 (Force HDMI Mode Timing).  The BeagleBone writes the same mode,
  // suffix and all, into uEnv.txt; Auto takes the suffix off again.
  let r = await request.put('/api/settings/ForceHDMIResolution', { data: '1024x768@75' });
  expect(r.ok(), await r.text()).toBe(true);
  r = await request.put('/api/settings/ForceHDMITiming', { data: 'M' });
  expect(r.ok(), await r.text()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^cmdline=.* video=HDMI-A-1:1024x768M@75$/m);
  r = await request.put('/api/settings/ForceHDMITiming', { data: '' });
  expect(r.ok()).toBe(true);
  await expect.poll(uenv, { timeout: 10_000 }).toMatch(/^cmdline=.* video=HDMI-A-1:1024x768@75$/m);
  expect(uenv().match(/video=HDMI-A-1/g)).toHaveLength(1);
});
