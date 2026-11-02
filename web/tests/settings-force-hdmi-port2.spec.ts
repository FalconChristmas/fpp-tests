import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { keepingSettings, php } from './privacy-helpers';
import { exists, putFile, readFile } from './settings-file';

// The second HDMI output's Force Resolution setting: which Pi models list it,
// and that a choice reaches the kernel command line as the second connector.

test.skip(!container, 'edits files inside the run-web.sh container');

const CMDLINE = '/boot/cmdline.txt';
const BASE = 'console=tty1 root=PARTUUID=fpp-tests-02 rootfstype=ext4 rootwait';

function listed(variant: string): boolean {
  return php(
    "$settings['Platform'] = 'Raspberry Pi';\n" +
    `$settings['Variant'] = '${variant}';\n` +
    "echo ShouldPrintSetting($settingInfos['ForceHDMIResolutionPort2']) ? 'yes' : 'no';").trim() === 'yes';
}

test('the second HDMI resolution is listed for a Pi 5 as well as a Pi 4, and not for older Pis', async () => {
  // Regression: 8ca4abc82.  ForceHDMIResolutionPort2 was limited to the
  // Pi 4, so a Pi 5, which has two HDMI outputs too, had no way to force the
  // second one's resolution.
  expect(listed('Pi 4')).toBe(true);
  expect(listed('Pi 5'), 'a Pi 5 has a second HDMI').toBe(true);
  expect(listed('Pi 3 Model B'), 'the control: a Pi with one HDMI').toBe(false);
});

test('the second HDMI resolution is set on the kernel command line as HDMI-A-2', async ({ request }) => {
  test.skip(exists('/boot/firmware') || exists(CMDLINE), 'the player already has a boot cmdline.txt');
  inPlayer('sh', '-c', "echo 'Raspberry Pi' > /etc/fpp/platform");
  try {
    await keepingSettings(async () => {
      putFile(CMDLINE, `${BASE}\n`);
      const r = await request.put('/api/settings/ForceHDMIResolutionPort2', { data: '1920x1080@60' });
      expect(r.ok(), await r.text()).toBe(true);
      const opts = readFile(CMDLINE).trim().split(/\s+/);
      expect(opts).toContain('video=HDMI-A-2:1920x1080@60');
      expect(opts.filter((o) => o.startsWith('video=HDMI-A-1:')), 'the first output is left alone').toEqual([]);
    });
  } finally {
    inPlayer('rm', '-f', '/etc/fpp/platform', CMDLINE);
  }
});
