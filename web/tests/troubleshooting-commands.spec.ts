import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { container, inPlayer } from './container';
import { putFile } from './settings-file';

// What the Troubleshooting page's commands print, run by
// troubleshootingHelper.php as troubleshoot-commands.json declares them.
// The container lacks some of the tools (ethtool, gpiodetect, kmsprint,
// raspinfo) and may not read the kernel log, so those are stand-ins in
// /usr/local/sbin, first on sudo's secure_path, that answer the way the real
// tool does; each stand-in's argument handling was checked against the real
// tool on a Pi 5.  The player claims a platform through /etc/fpp/platform for
// the groups that only show on a Pi or a Beagle.

test.skip(!container, 'changes the platform and runs the commands inside the run-web.sh container');

const PLATFORM = '/etc/fpp/platform';
const BIN = '/usr/local/sbin';
const MEDIA = '/home/fpp/media';

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

// A command's output once it has loaded.
async function output(page: Page, grp: string, key: string, until: string | RegExp): Promise<string> {
  const out = page.locator(`#pills-${grp} #command_${key}`);
  await expect(out, key).toContainText(until, { timeout: 30_000 });
  return out.innerText();
}

const hotlink = (page: Page, grp: string, key: string) =>
  page.locator(`#troubleshooting-hot-links-${grp} a[href="#header_${key}"]`);

// du -h's sizes, in bytes.
function bytes(size: string): number {
  const m = size.match(/^([\d.]+)([KMGT]?)$/);
  expect(m, `not a human-readable size: ${size}`).toBeTruthy();
  return parseFloat(m![1]) * 1024 ** ' KMGT'.indexOf(m![2] || ' ');
}

test('the Disk tab gives the filesystems in human units and the media folders largest first', async ({ page }) => {
  // Regression: eb4ec7582.  Filesystems was df -k, sizes in 1K blocks.
  // Regression: cd78f0d03.  eb4ec7582 put the media folder sizes under
  // Filesystems, smallest first; they became their own Media Directory Usage
  // command, largest first, and both got descriptions.
  const big = `${MEDIA}/videos/fpp-tests-du-big.bin`;
  const small = `${MEDIA}/music/fpp-tests-du-small.bin`;
  inPlayer('sh', '-c', `dd if=/dev/zero of=${big} bs=1M count=3 2>/dev/null && dd if=/dev/zero of=${small} bs=1M count=1 2>/dev/null`);
  try {
    await openTab(page, 'Disk');
    await expect(hotlink(page, 'Disk', 'Filesystems')).toHaveText('Filesystems');
    await expect(hotlink(page, 'Disk', 'MediaDirectoryUsage')).toHaveText('Media Directory Usage');
    const results = page.locator('#troubleshooting-results-Disk');
    await expect(results).toContainText('Command Description: File System Layout and Usage');
    await expect(results).toContainText('Command Description: Media Directory Usage ordered largest to smallest');

    const df = await output(page, 'Disk', 'Filesystems', 'Mounted on');
    expect(df.split('\n')[0], 'df header').toMatch(/^Filesystem\s+Size\s+Used\s+Avail/);
    expect(df).not.toContain('1K-blocks');
    expect(df, 'the media folders are their own command now').not.toContain(`${MEDIA}/videos/`);

    const du = await output(page, 'Disk', 'MediaDirectoryUsage', `${MEDIA}/videos/`);
    const rows = du.trim().split('\n').map((l) => l.split(/\s+/));
    expect(rows[0], du).toEqual(['3.0M', `${MEDIA}/videos/`]);
    expect(rows.find((r) => r[1] === `${MEDIA}/music/`), du).toEqual(['1.0M', `${MEDIA}/music/`]);
    const sizes = rows.map((r) => bytes(r[0]));
    expect(sizes, du).toEqual([...sizes].sort((a, b) => b - a));
  } finally {
    inPlayer('rm', '-f', big, small);
  }
});

test('the Wired command runs ethtool on USB Ethernet (enx) interfaces too', async ({ page }) => {
  // Regression: d610ed7e7.  Only interface names containing "eth" were
  // passed to ethtool, so a USB adapter with a MAC-pinned enx name was
  // left out.  ifconfig adds an enx adapter and a Wi-Fi one to the real
  // list; ethtool prints its header line.
  const ENX = 'enx00e04c680001';
  standIn(`${BIN}/ifconfig`, `/usr/sbin/ifconfig "$@"
[ $# -eq 0 ] || exit 0
printf '%s\\n' "${ENX}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500" "        ether 00:e0:4c:68:00:01  txqueuelen 1000  (Ethernet)" ""
printf '%s\\n' "wlan0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500" "        ether 00:11:22:33:44:55  txqueuelen 1000  (Ethernet)" ""
`);
  standIn(`${BIN}/ethtool`, 'echo "Settings for $1:"\necho "\tLink detected: yes"\n');
  await openTab(page, 'Networking');
  const out = await output(page, 'Networking', 'Wired', `Settings for ${ENX}:`);
  expect(out).toContain('Settings for eth0:');
  expect(out).not.toContain('Settings for wlan0:');
});

test('a Beagle gets the GPIO tab, and a BeagleBone 64 its pinctrl', async ({ page }) => {
  // Feature: 4cc8195cd.  The GPIO group (gpiodetect, gpioinfo) was for the
  // Pi only; the Beagles got it, with descriptions, and the 64-bit Beagles
  // TI's pinctrl -q.
  // Also a60e125b5: each group and command names the platforms it is for,
  // and the page shows only those that apply to this one.
  standIn(`${BIN}/gpiodetect`, 'echo "gpiochip0 [600000.gpio] (92 lines)"\n');
  standIn(`${BIN}/gpioinfo`, 'echo "gpiochip0 - 92 lines:"\necho "\tline   0:      unnamed       unused   input  active-high"\n');
  standIn(`${BIN}/pinctrl`, '[ "$1" = "-q" ] || { echo "pinctrl: unexpected arguments: $*" >&2; exit 1; }\necho "P8_03 : gpio1_6 : mode 7"\n');

  setPlatform('BeagleBone 64');
  await openTab(page, 'GPIO');
  for (const [k, title] of [['GPIO', 'GPIO'], ['GPIOInfo', 'GPIO Info'], ['pinctrl', 'pinctrl']]) {
    await expect(hotlink(page, 'GPIO', k), k).toHaveText(title);
  }
  await expect(page.locator('#troubleshooting-results-GPIO')).toContainText('Command Description: Information about the GPIO chips on the system');
  await output(page, 'GPIO', 'GPIO', 'gpiochip0 [600000.gpio] (92 lines)');
  await output(page, 'GPIO', 'GPIOInfo', 'gpiochip0 - 92 lines:');
  await output(page, 'GPIO', 'pinctrl', 'P8_03 : gpio1_6 : mode 7');

  setPlatform('BeagleBone Black');
  await openTab(page, 'GPIO');
  await output(page, 'GPIO', 'GPIO', 'gpiochip0 [600000.gpio] (92 lines)');
  await expect(hotlink(page, 'GPIO', 'GPIOInfo')).toHaveText('GPIO Info');
  await expect(hotlink(page, 'GPIO', 'pinctrl'), 'pinctrl -q is the 64-bit Beagles\' tool').toHaveCount(0);
});

test('a Pi\'s Video tab runs kmsprint, kmsprint -p and kmsprint -m', async ({ page }) => {
  // Feature: 1a6127e22.  (c80ce6cc7 later kept them to the Pi, the one
  // platform that still ships kmsprint.)  The stand-in prints what each
  // form adds, as the real one on a Pi 5 does: properties with -p, modes
  // with -m.
  standIn(`${BIN}/kmsprint`, `echo "Connector 0 (35) HDMI-A-1 (connected)"
case "$1" in
-p) echo "    DPMS (2) = 0 (On) [On=0|Standby=1|Suspend=2|Off=3]" ;;
-m) echo "    1920x1080@60.00 148.500 1920/88/44/148/+ 1080/4/5/36/+ 60 (60.00) P|D" ;;
"") ;;
*) echo "kmsprint: unknown option $1" >&2; exit 1 ;;
esac
`);
  setPlatform('Raspberry Pi');
  await openTab(page, 'Video');
  for (const [k, title] of [['kmsprint', 'kmsprint'], ['kmsprintProps', 'kmsprint -p'], ['kmsprintList', 'kmsprint -m']]) {
    await expect(hotlink(page, 'Video', k), k).toHaveText(title);
  }
  const plain = await output(page, 'Video', 'kmsprint', 'HDMI-A-1 (connected)');
  expect(plain).not.toMatch(/DPMS|1920x1080/);
  await output(page, 'Video', 'kmsprintProps', 'DPMS (2) = 0 (On)');
  await output(page, 'Video', 'kmsprintList', '1920x1080@60.00');
});

test('the Webserver tab shows Apache\'s mod_status page, without curl\'s progress meter', async ({ page }) => {
  // Feature: ee0ec548b.  The status page, fetched from the player itself,
  // so Apache can keep /server-status to localhost.  The real Apache's
  // answer, shown in a frame.
  // Regression: 6d1a56de8.  curl ran without -s: the helper keeps stderr,
  // so its progress meter came first in the output.
  await openTab(page, 'Webserver');
  await expect(hotlink(page, 'Webserver', 'Server-Status')).toHaveText('Apache Server Status');
  // A frame once loaded; output that doesn't start as a page is shown as text.
  const out = page.locator('#pills-Webserver #command_Server-Status');
  const text = () => out.evaluate((e) => e.getAttribute('srcdoc') ?? e.textContent ?? '');
  await expect.poll(text, { timeout: 30_000 }).toContain('Apache Server Status for localhost');
  const doc = await text();
  expect(doc).toContain('Server MPM:');
  expect(doc, 'curl\'s progress meter').not.toMatch(/% Total|Dload|Xferd/);
  expect(await out.evaluate((e) => e.tagName), 'shown as a page').toBe('IFRAME');
});

test('the Boot tab has the kernel log with wall-clock times', async ({ page }) => {
  // Regression: fa6944547.  The kernel log was only in RPI Info (raspinfo,
  // Pi only); it became "dmesg -T" in Boot on every platform.  The
  // container can't read the kernel log: dmesg stands in, printing
  // timestamps as util-linux's does, seconds since boot unless -T.
  standIn(`${BIN}/dmesg`, `case "$1" in
-T) echo "[Thu Oct 22 11:20:53 2026] Booting Linux on physical CPU 0x0000000000" ;;
"") echo "[    0.000000] Booting Linux on physical CPU 0x0000000000" ;;
*) echo "dmesg: invalid option -- '$1'" >&2; exit 1 ;;
esac
`);
  await openTab(page, 'Boot');
  await expect(hotlink(page, 'Boot', 'DMESGDLogs')).toHaveText('dmesg');
  await output(page, 'Boot', 'DMESGDLogs', '[Thu Oct 22 11:20:53 2026] Booting Linux');
});

test('a Pi\'s RPI Info stops before raspinfo\'s kernel log', async ({ page }) => {
  // Regression: fa6944547.  RPI Info printed all of raspinfo, the kernel log
  // included, which Boot now has.  The stand-in prints raspinfo's section
  // headers in a Pi 5's order: its "dmesg log" section, then the firmware
  // configuration and EEPROM.
  // Also 5f7364495: the RPIINFO command (raspinfo) is offered on a Pi.
  putFile('/usr/bin/raspinfo', `#!/bin/sh
# fpp-tests stand-in
printf '%s\\n' "System Information" "------------------" "Raspberry Pi 5 Model B Rev 1.0" "" "dmesg log" "---------" "[    0.000000] Booting Linux on physical CPU 0x0000000000" "" "Firmware Configuration" "----------------------" "EEPROM" "BOOTLOADER: up to date"
echo stand-in > raspinfo.txt
`);
  inPlayer('chmod', '755', '/usr/bin/raspinfo');
  standIns.push('/usr/bin/raspinfo');
  setPlatform('Raspberry Pi');
  await openTab(page, 'RPISPECIFIC');
  const out = await output(page, 'RPISPECIFIC', 'RPIINFO', 'Raspberry Pi 5 Model B Rev 1.0');
  expect(out.trim().split('\n').pop()).toBe('dmesg log');
  expect(out).not.toMatch(/Booting Linux|Firmware Configuration|BOOTLOADER/);
});

test('Command Presets loads to the end with config.php before common.php', async ({ page }) => {
  // Regression: b855fe860.  commandPresets.php included config.php, which
  // requires common.php, and then included common.php again: "Cannot
  // redeclare function check()", and the page stopped after the menu.  (The
  // same commit's change to copystorage.php changed nothing: its include of
  // common.php came first, and the later require_once skipped it.)
  await page.goto('/commandPresets.php');
  await expect(page.locator('#tblCommandsBody')).toBeAttached();
  await expect(page.locator('#modalDialogBase'), 'the footer').toBeAttached();
});
