import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { setSettingInFile, snapshotSettings } from './settings-file';

// Covers the fix that shows the HDMI display settings -- Force HDMI Display,
// Enable HDMI Display (BeagleBone) and Force HDMI Resolution -- in both Media
// Backend modes (issue #3135; fixed by 550be3f2c).  They sat in the Simple Video group, and the
// resolutions were Simple-only children of MediaBackend, so Advanced (Full
// PipeWire) mode hid them -- though they only edit the boot files
// (cmdline.txt / uEnv.txt), which handle_boot_actions re-applies at every
// boot whatever the backend.  A value set in Simple mode kept applying in
// Advanced with no way to see or change it, and the workaround for a
// projector whose EDID aspect doesn't match its preferred mode (kmssink
// ENOSPC) was out of reach there.
//
// The settings are Raspberry Pi / BeagleBone only, so the run-web.sh player is
// made one by its /etc/fpp/platform.

test.skip(!container, 'makes the run-web.sh container a Pi or a BeagleBone');

const PLATFORM = '/etc/fpp/platform';
let restoreSettings: (() => void) | undefined;

function asPlatform(platform: string) {
  inPlayer('sh', '-c', `echo '${platform}' > ${PLATFORM}`);
}

test.beforeEach(() => {
  restoreSettings = snapshotSettings();
});

test.afterEach(() => {
  try {
    restoreSettings?.();
  } finally {
    inPlayer('rm', '-f', PLATFORM);
  }
});

// Simple mode passes before the fix too: it is the control for Advanced.
for (const backend of ['pipewire-simple', 'pipewire']) {
  test(`the HDMI display settings are shown with MediaBackend=${backend}`, async ({ page }) => {
    asPlatform('Raspberry Pi');
    setSettingInFile('MediaBackend', backend);
    await page.goto('/settings.php#settings-av');
    await expect(page.locator('#MediaBackend')).toHaveValue(backend, { timeout: 15_000 });
    await expect(page.locator('#ForceHDMIRow'), 'Force HDMI Display is hidden in this mode').toBeVisible();
    await expect(page.locator('#ForceHDMIResolutionRow'), 'the resolution control is hidden in this mode').toBeVisible();
    await expect(page.locator('#ForceHDMIResolution')).toBeVisible();
  });
}

test('switching the Media Backend in the page leaves the HDMI display settings shown', async ({ page }) => {
  asPlatform('Raspberry Pi');
  setSettingInFile('MediaBackend', 'pipewire-simple');
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire-simple', { timeout: 15_000 });
  // The visibility half of the select's change handler: MediaBackendChanged()
  // saves the setting (and asks for a reboot), then calls this on success.
  await page.evaluate(() => {
    const sel = document.querySelector('#MediaBackend') as HTMLSelectElement;
    sel.value = 'pipewire';
    (window as any).UpdateMediaBackendChildren(0);
  });
  await expect(page.locator('#pipeWireSection')).toBeVisible();
  await expect(page.locator('#ForceHDMIRow')).toBeVisible();
  await expect(page.locator('#ForceHDMIResolutionRow')).toBeVisible();
});

test('a board none of the HDMI display settings apply to gets no empty heading', async ({ page }) => {
  // A BeagleBone-platform board that isn't a BeagleBone Black variant (here
  // the container, whose device tree names no model; a PocketBeagle or a
  // BeagleBone Green has the same answer): every setting in the group is
  // dropped by its variants, and the group printed its heading over an empty
  // box.  PrintSettingGroup() now leaves out a group with nothing to show
  // (7e5913f47).
  asPlatform('BeagleBone Black');
  setSettingInFile('MediaBackend', 'pipewire');
  await page.goto('/settings.php#settings-av');
  await expect(page.locator('#MediaBackend')).toHaveValue('pipewire', { timeout: 15_000 });
  await expect(page.locator('#EnableBBBHDMIRow')).toHaveCount(0);
  await expect(page.locator('#ForceHDMIResolutionRow')).toHaveCount(0);
  await expect(page.locator('h2', { hasText: /^HDMI (Display|Resolution)$/ })).toHaveCount(0);
});

test('the Force HDMI Resolution modes are each listed once, at a real refresh rate', async ({ request }) => {
  // hdmi_modes.json (moved out of hdmi_table.json.php) listed 1600x900@60
  // twice in the Pi 4/5 modes and had "2560x720@12", a typo for @120 that
  // asked the kernel for a 12 Hz mode.  Fixed by 76adf8dcc.
  const modes = await (await request.get('/hdmi_modes.json')).json();
  const all: string[] = [...modes.all, ...modes.pi4pi5];
  expect(all.filter((m, i) => all.indexOf(m) !== i), 'listed twice').toEqual([]);
  expect(all.filter(m => !/^\d+x\d+@(24|25|30|50|60|70|75|80|85|100|120)$/.test(m)), 'odd refresh rate').toEqual([]);
});
