import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// More of the Troubleshooting page's commands, run as
// troubleshootingHelper.php runs them from troubleshoot-commands.json, with
// stand-ins for the tools the container lacks (see
// troubleshooting-commands.spec.ts, whose pattern this follows): each
// stand-in prints the arguments it was called with, so a test sees what the
// command line became.

test.skip(!container, 'changes the platform and runs the commands inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const BIN = '/usr/local/sbin';

let savedPlatform = '';
const standIns: string[] = [];

function standIn(path: string, script: string) {
  putFile(path, `#!/bin/sh\n# fpp-tests stand-in\n${script}`);
  inPlayer('chmod', '755', path);
  standIns.push(path);
}

function setPlatform(p: string) {
  inPlayer('sh', '-c', `mkdir -p /etc/fpp && printf '%s' '${p}' > ${PLATFORM}`);
}

test.beforeEach(() => {
  savedPlatform = inPlayer('sh', '-c', `cat ${PLATFORM} 2>/dev/null || true`);
});
test.afterEach(() => {
  inPlayer('sh', '-c', savedPlatform ? `printf '%s' '${savedPlatform.trim()}' > ${PLATFORM}` : `rm -f ${PLATFORM}`);
  if (standIns.length) inPlayer('rm', '-f', ...standIns.splice(0));
});

async function openTab(page: Page, grp: string) {
  await page.goto('/troubleshooting.php');
  await page.locator(`#pills-${grp}-tab`).click();
  await expect(page.locator(`#pills-${grp}`)).toBeVisible();
}

async function output(page: Page, grp: string, key: string, until: string | RegExp): Promise<string> {
  const out = page.locator(`#pills-${grp} #command_${key}`);
  await expect(out, key).toContainText(until, { timeout: 30_000 });
  return out.innerText();
}

const hotlink = (page: Page, grp: string, key: string) =>
  page.locator(`#troubleshooting-hot-links-${grp} a[href="#header_${key}"]`);

test('the Git tab shows the git configuration', async ({ page }) => {
  // Feature: 1eba147ef.  `git config --list` was added to the Git group.
  standIn(`${BIN}/git`, '[ "$1 $2" = "config --list" ] && { echo "user.name=fpp-tests-user"; exit 0; }\nexec /usr/bin/git "$@"\n');
  await openTab(page, 'Git');
  await expect(hotlink(page, 'Git', 'GitConfigInfo')).toBeVisible();
  await output(page, 'Git', 'GitConfigInfo', 'user.name=fpp-tests-user');
});

test('the default gateway command pings the gateway netstat lists', async ({ page }) => {
  // Regression: d1ec8350f.  The gateway was cut out of netstat's line with
  // awk quoting that passed a literal $2, so the ping got no address.
  standIn(`${BIN}/netstat`, 'printf "%s\\n" "Kernel IP routing table" "Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface" "0.0.0.0         10.9.8.7        0.0.0.0         UG        0 0          0 eth0"\n');
  standIn(`${BIN}/ping`, 'echo "stand-in ping: $*"\n');
  await openTab(page, 'Networking');
  await output(page, 'Networking', 'DefaultGateway', 'stand-in ping: -c 1 10.9.8.7');
});

test('the RTC and i2c commands name their configured device, not a placeholder', async ({ page }) => {
  // Regression: 688da9d26.  [[rtcDevice]] and [[i2cDevice]] reached the
  // tools as typed.
  standIn(`${BIN}/hwclock`, 'echo "stand-in hwclock: $*"\n');
  standIn(`${BIN}/i2cdetect`, 'echo "stand-in i2cdetect: $*"\n');
  await openTab(page, 'DateTime');
  const rtc = await output(page, 'DateTime', 'RTC', 'stand-in hwclock:');
  expect(rtc).toContain('stand-in hwclock: -v -r -f /dev/rtc');
  expect(rtc).not.toMatch(/\[\[|\$rtcDevice/);
  await openTab(page, 'i2c');
  const i2c = await output(page, 'i2c', 'i2cdetect', 'stand-in i2cdetect:');
  expect(i2c).toMatch(/stand-in i2cdetect: -y -r \d/);
  expect(i2c).not.toMatch(/\[\[|\$i2cDevice/);
});

test('the SMART command reads each disk but not the SD card or zram', async ({ page }) => {
  // Features: 5bcc94c49 and f3a8a60ce.  smartctl was asked for "-A /dev/" +
  // an empty or wrong name before the loop variable was fixed.
  standIn(`${BIN}/lsblk`, 'printf "%s\\n" sda zram0 mmcblk0 nvme0n1\n');
  standIn(`${BIN}/smartctl`, 'echo "stand-in smartctl: $*"\n');
  await openTab(page, 'Disk');
  await expect(hotlink(page, 'Disk', 'SMART')).toBeVisible();
  const out = await output(page, 'Disk', 'SMART', 'stand-in smartctl: -A /dev/sda');
  expect(out).toContain('stand-in smartctl: -A /dev/nvme0n1');
  expect(out).not.toMatch(/zram|mmcblk/);
});

test('a Pi\'s tabs offer dtc, vclog and pinctrl, and RPI Info leaves no file behind', async ({ page }) => {
  // Features: 4d1baa9ae, 27028776f, bc2ae6aad.  Regression: 63176893d.
  standIn(`${BIN}/dtc`, 'echo "stand-in dtc: $*"\n');
  putFile('/usr/bin/vclog', '#!/bin/sh\n# fpp-tests stand-in\necho "stand-in vclog: $*"\n');
  putFile('/usr/bin/pinctrl', '#!/bin/sh\n# fpp-tests stand-in\necho "stand-in pinctrl: $*"\n');
  putFile('/usr/bin/raspinfo', '#!/bin/sh\n# fpp-tests stand-in\necho "Raspberry Pi 5 Model B Rev 1.0"\necho "dmesg log"\necho stand-in > raspinfo.txt\n');
  inPlayer('chmod', '755', '/usr/bin/vclog', '/usr/bin/pinctrl', '/usr/bin/raspinfo');
  standIns.push('/usr/bin/vclog', '/usr/bin/pinctrl', '/usr/bin/raspinfo');
  setPlatform('Raspberry Pi');
  await openTab(page, 'RPISPECIFIC');
  for (const [k, title] of [['DTC', 'DTC'], ['VCLOG', 'VCLOG'], ['PINCTRL', 'PINCTRL']]) {
    await expect(hotlink(page, 'RPISPECIFIC', k), `${k} (${title})`).toBeVisible();
  }
  await output(page, 'RPISPECIFIC', 'DTC', 'stand-in dtc: -I fs /proc/device-tree');
  await output(page, 'RPISPECIFIC', 'VCLOG', 'stand-in vclog: --msg');
  const pin = await output(page, 'RPISPECIFIC', 'PINCTRL', 'stand-in pinctrl:');
  expect(pin).not.toContain('-q');
  await output(page, 'RPISPECIFIC', 'RPIINFO', 'Raspberry Pi 5 Model B Rev 1.0');
  const left = inPlayer('sh', '-c', 'find / -xdev -name raspinfo.txt 2>/dev/null || true').trim();
  expect(left, 'raspinfo.txt left on the filesystem').toBe('');
});
