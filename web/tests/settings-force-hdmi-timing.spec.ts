import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php } from './privacy-helpers';
import { exists, putFile, readFile, setSettingInFile, settingInFile, snapshotSettings } from './settings-file';

// Force HDMI Mode Timing (and its Port 2 twin): how the kernel makes a forced
// mode's timings when the display doesn't list that mode, written as the
// video= mode's M (CVT) or MR (CVT reduced blanking) suffix.  Also the
// Force HDMI Resolution list these settings sit under: sorted, and keeping a
// saved value it doesn't offer.  The player is made a Pi for the test
// (/etc/fpp/platform) and given a cmdline.txt, as in settings-force-hdmi.

test.skip(!container, 'edits files inside the run-web.sh container');

const CMDLINE = '/boot/cmdline.txt';
const BASE = 'console=tty1 root=PARTUUID=fpp-tests-02 rootfstype=ext4 rootwait';

async function asPi<T>(fn: () => Promise<T>): Promise<T> {
  test.skip(exists('/boot/firmware') || exists(CMDLINE), 'the player already has a boot cmdline.txt');
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    return await keepingSettings(fn);
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform', CMDLINE);
  }
}

const video = (port: number) => readFile(CMDLINE).trim().split(/\s+/).filter((o) => o.startsWith(`video=HDMI-A-${port}:`));

test('the mode timing is written as the video= mode suffix, and taken off again', async ({ request }) => {
  // Feature: 0a870c197 (Force HDMI Mode Timing).
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    const put = async (name: string, value: string) => {
      const r = await request.put(`/api/settings/${name}`, { data: value });
      expect(r.ok(), `${name}=${value}: ${await r.text()}`).toBe(true);
    };
    await put('ForceHDMIResolution', '1024x768@80');
    expect(video(1), 'the control: Auto adds nothing').toEqual(['video=HDMI-A-1:1024x768@80']);
    await put('ForceHDMITiming', 'MR');
    expect(video(1)).toEqual(['video=HDMI-A-1:1024x768MR@80']);
    await put('ForceHDMITiming', 'M');
    expect(video(1)).toEqual(['video=HDMI-A-1:1024x768M@80']);
    // A new resolution keeps the timing.
    await put('ForceHDMIResolution', '1920x1080@120');
    expect(video(1)).toEqual(['video=HDMI-A-1:1920x1080M@120']);
    await put('ForceHDMITiming', '');
    expect(video(1), 'back to Auto').toEqual(['video=HDMI-A-1:1920x1080@120']);
    await put('ForceHDMITiming', 'MR');
    await put('ForceHDMIResolution', 'Default');
    expect(video(1), 'a timing on its own forces nothing').toEqual([]);
    expect(readFile(CMDLINE).trim().split(/\s+/)).toEqual(BASE.split(' '));
  });
});

test('a resolution saved with its own timing letter is used as it is', async ({ request }) => {
  // A guard for 0a870c197: such a value, saved before the setting existed,
  // worked then and must not gain a second letter now.
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    expect((await request.put('/api/settings/ForceHDMITiming', { data: 'MR' })).ok()).toBe(true);
    const r = await request.put('/api/settings/ForceHDMIResolution', { data: '1024x768M@80' });
    expect(r.ok(), await r.text()).toBe(true);
    expect(video(1)).toEqual(['video=HDMI-A-1:1024x768M@80']);
  });
});

test('a mode timing other than Auto, CVT or CVT reduced blanking is refused', async ({ request }) => {
  // Feature: 0a870c197.
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    for (const bad of ['R', 'm', 'MRR', 'M i', 'M;reboot']) {
      const r = await request.put('/api/settings/ForceHDMITiming', { data: bad });
      expect(r.status(), `"${bad}"`).toBe(400);
    }
    // The control: a valid one is taken.
    expect((await request.put('/api/settings/ForceHDMITiming', { data: 'M' })).ok()).toBe(true);
  });
});

test('the second port takes its own timing, and leaves the first alone', async ({ request }) => {
  // Feature: 0a870c197.
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    for (const [name, value] of [['ForceHDMIResolution', '1920x1080@60'], ['ForceHDMIResolutionPort2', '1280x720@100'],
                                 ['ForceHDMITimingPort2', 'MR']]) {
      const r = await request.put(`/api/settings/${name}`, { data: value });
      expect(r.ok(), `${name}: ${await r.text()}`).toBe(true);
    }
    expect(video(2)).toEqual(['video=HDMI-A-2:1280x720MR@100']);
    expect(video(1), 'the first port has no timing set').toEqual(['video=HDMI-A-1:1920x1080@60']);
  });
});

function table(subPlatform: string, saved: Record<string, string> = {}, platform = 'Raspberry Pi'): string[] {
  const set = Object.entries(saved).map(([k, v]) => `$settings['${k}'] = '${v}';\n`).join('');
  return JSON.parse(php(`$settings['Platform'] = '${platform}';\n$settings['SubPlatform'] = '${subPlatform}';\n${set}` +
    "include '/opt/fpp/www/hdmi_table.json.php';"));
}

test('the resolution list is sorted by size and refresh rate, with Default first', () => {
  // Feature: d26deb30d.
  // The Pi 4/5 modes were added after the others, in no order: 1920x1080@60
  // came after 1920x1080@30, and 1024x600 at the very end.
  const list = table('Raspberry Pi 4 Model B Rev 1.4');
  expect(list[0]).toBe('Default');
  const key = (m: string) => m.match(/^(\d+)x(\d+)@(\d+)$/)!.slice(1).map(Number);
  const modes = list.slice(1);
  const sorted = [...modes].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  expect(modes).toEqual(sorted);
  // Rates for LED wall shows at 25, 40 and 50 fps.
  for (const m of ['1920x1080@50', '1920x1080@100', '1920x1080@120', '1280x720@50', '1024x768@80']) {
    expect(modes, m).toContain(m);
  }
  expect(table('Raspberry Pi 3 Model B Plus Rev 1.3'), 'a Pi 3 is not offered them').not.toContain('1920x1080@120');
});

test('each board is offered the modes its HDMI output can drive', () => {
  // Feature: 0d8adcaf4.
  // The faster modes were offered on a Pi 4 or 5 only, though a Pi 0-3 drives
  // up to 162 MHz (1080p at 50 Hz, 720p at 120 Hz), and a BeagleBone Black
  // was offered modes past its display controller's 126 MHz.
  const pi3 = table('Raspberry Pi 3 Model B Plus Rev 1.3');
  for (const m of ['1280x720@120', '1920x1080@50', '1024x768@120', '1600x1200@60']) {
    expect(pi3, `Pi 3: ${m}`).toContain(m);
  }
  expect(pi3, 'Pi 3: 297 MHz is past its HDMI').not.toContain('1920x1080@100');
  const bbb = table('BeagleBone Black', {}, 'BeagleBone Black');
  for (const m of ['1024x768@80', '1280x720@50', '1920x1080@25', '1280x1024@60']) {
    expect(bbb, `BeagleBone: ${m}`).toContain(m);
  }
  for (const m of ['1280x720@100', '1920x1080@50', '1600x1200@60', '1280x1024@75']) {
    expect(bbb, `BeagleBone: ${m}`).not.toContain(m);
  }
  // The control: a Pi 4 has them all.
  const pi4 = table('Raspberry Pi 4 Model B Rev 1.4');
  for (const m of ['1920x1080@120', '1280x720@120', '1600x1200@60', '1920x1080@25']) {
    expect(pi4, `Pi 4: ${m}`).toContain(m);
  }
});

test('a saved resolution the list does not offer is still offered, once', () => {
  // Regression: eddaff06e.
  const list = table('Raspberry Pi 4 Model B Rev 1.4', { ForceHDMIResolution: '1024x768M@80', ForceHDMIResolutionPort2: 'Default' });
  expect(list.filter((m) => m === '1024x768M@80')).toHaveLength(1);
  expect(list.filter((m) => m === 'Default'), 'Default is listed once').toHaveLength(1);
  // The control: an offered value is not added again.
  const plain = table('Raspberry Pi 4 Model B Rev 1.4', { ForceHDMIResolution: '1920x1080@60' });
  expect(plain.filter((m) => m === '1920x1080@60')).toHaveLength(1);
});

test.describe('on the settings page', () => {
  const PLATFORM = '/etc/fpp/platform';
  let restoreSettings: (() => void) | undefined;
  test.beforeEach(() => {
    restoreSettings = snapshotSettings();
    inPlayer('sh', '-c', `echo 'Raspberry Pi' > ${PLATFORM}`);
    setSettingInFile('MediaBackend', 'pipewire-simple');
  });
  test.afterEach(() => {
    try {
      restoreSettings?.();
    } finally {
      inPlayer('rm', '-f', PLATFORM);
    }
  });

  test('Force HDMI Mode Timing is an Advanced setting', async ({ page }) => {
    // Feature: 0a870c197.
    setSettingInFile('uiLevel', '0');
    await page.goto('/settings.php#settings-av');
    await expect(page.locator('#ForceHDMIResolutionRow')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#ForceHDMITimingRow'), 'shown at the Basic level').toHaveCount(0);

    setSettingInFile('uiLevel', '1');
    await page.reload();
    await expect(page.locator('#ForceHDMIResolutionRow')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#ForceHDMITimingRow')).toBeVisible();
    await expect(page.locator('#ForceHDMITiming option')).toHaveText(['Auto', 'Standard VESA (CVT)', 'CVT Reduced Blanking']);
  });

  test('opening the page keeps a saved resolution the list does not offer', async ({ page }) => {
    // Regression: eddaff06e.
    // The select was filled from the list alone, so it showed its first
    // option, Default, for a value set through the API; the page does not
    // save it in the meantime.
    setSettingInFile('ForceHDMIResolution', '1024x768M@80');
    await page.goto('/settings.php#settings-av');
    await expect(page.locator('#ForceHDMIResolution')).toHaveValue('1024x768M@80', { timeout: 15_000 });
    await page.waitForTimeout(1000);
    expect(settingInFile('ForceHDMIResolution'), 'the page saved another value').toBe('1024x768M@80');
  });
});
