import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php } from './privacy-helpers';
import { exists, putFile, readFile } from './settings-file';

// The Raspberry Pi HDMI settings, which edit the kernel command line in the
// boot partition's cmdline.txt.  The player is made a Pi for the test
// (/etc/fpp/platform) and given a cmdline.txt; nothing boots it, so the
// receiving end checked is the line as the kernel would be handed it.

test.skip(!container, 'edits files inside the run-web.sh container');

const CMDLINE = '/boot/cmdline.txt';
const BASE = 'console=tty1 root=PARTUUID=fpp-tests-02 rootfstype=ext4 rootwait';

async function asPi<T>(fn: () => Promise<T>): Promise<T> {
  test.skip(exists('/boot/firmware') || exists(CMDLINE), 'the player already has a boot cmdline.txt');
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    return await keepingSettings(fn);
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform', CMDLINE, '/home/fpp/foo.txt');
  }
}

function options(): string[] {
  return readFile(CMDLINE).trim().split(/\s+/);
}

test('Force HDMI leaves exactly one vc4.force_hotplug option, and none when off', async ({ request }) => {
  // Regression: b7d4a86ce.  Each save of Force HDMI on appended another
  // vc4.force_hotplug=0x03 to cmdline.txt, and turning it off removed only the
  // last copy, so a box that had been toggled kept forcing HDMI.
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    for (let i = 0; i < 2; i++) {
      const r = await request.put('/api/settings/ForceHDMI', { data: '1' });
      expect(r.ok(), await r.text()).toBe(true);
    }
    expect(options().filter((o) => o.startsWith('vc4.force_hotplug='))).toEqual(['vc4.force_hotplug=0x03']);
    expect(readFile(CMDLINE).split('\n').filter((l) => l), 'cmdline.txt must stay one line').toHaveLength(1);

    const r = await request.put('/api/settings/ForceHDMI', { data: '0' });
    expect(r.ok()).toBe(true);
    expect(options()).toEqual(BASE.split(' '));

    // A cmdline.txt toggled by an older FPP, with copies left over.
    putFile(CMDLINE, `${BASE} vc4.force_hotplug=0x03 vc4.force_hotplug=0x03\n`);
    await request.put('/api/settings/ForceHDMI', { data: '0' });
    expect(options().filter((o) => o.startsWith('vc4.force_hotplug=')), 'a leftover copy kept HDMI forced').toEqual([]);
  });
});

test('an HDMI resolution is set on the kernel command line and leaves no debug file', async ({ request }) => {
  // Regression: 9079c5ad4.  SetForceHDMIResolution() wrote its arguments to
  // /home/fpp/foo.txt on every save.
  await asPi(async () => {
    putFile(CMDLINE, `${BASE}\n`);
    const r = await request.put('/api/settings/ForceHDMIResolution', { data: '1920x1080@60' });
    expect(r.ok(), await r.text()).toBe(true);
    // The control: the setting was applied.
    expect(options()).toContain('video=HDMI-A-1:1920x1080@60');
    expect(exists('/home/fpp/foo.txt'), 'the debug write is back').toBe(false);
  });
});

test("every 4K HDMI resolution a Pi 4 offers is one the kernel command line gets", async ({ request }) => {
  // Regression: 9885e7995.  The 3840x2160 entries were spelled with a
  // multiplication sign (U+00D7), which a kernel video= mode doesn't parse
  // and the root-shell setting validation now refuses, so picking one did
  // nothing.  The list is the tree's own hdmi_table.json.php, run with the
  // SubPlatform a Pi 4 reports (the container has no device tree to read it
  // from); each choice is then saved through the API.
  await asPi(async () => {
    const list: string[] = JSON.parse(php(
      "$settings['SubPlatform'] = 'Raspberry Pi 4 Model B Rev 1.4';\n" +
      "include '/opt/fpp/www/hdmi_table.json.php';"));
    const uhd = list.filter((m) => m.startsWith('3840'));
    expect(uhd.length, 'the Pi 4 list has no 3840x2160 modes').toBe(5);
    for (const mode of list.filter((m) => m !== 'Default')) {
      expect(mode, 'not a <width>x<height>@<rate> mode').toMatch(/^\d+x\d+@\d+$/);
    }
    for (const mode of uhd) {
      putFile(CMDLINE, `${BASE}\n`);
      const r = await request.put('/api/settings/ForceHDMIResolution', { data: mode });
      expect(r.ok(), await r.text()).toBe(true);
      expect(options(), `choosing ${mode}`).toContain(`video=HDMI-A-1:${mode}`);
    }
  });
});
