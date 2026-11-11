import { test, expect } from './fixtures';
import { container, inPlayer } from './container';
import { snapshotSettings } from './settings-file';
import { standInCommand } from './pw-helpers';

// Choosing the storage device on the Storage tab (PUT /api/settings/
// storageDevice): fstab's /home/fpp/media line is rewritten to mount that
// partition there at the next boot, with the options its filesystem needs --
// FAT and exFAT have no owners on disk, so they are mounted as the fpp user,
// BTRFS compressed, and only those that have a check are checked -- or, for
// the root device or --none--, commented out so the media stays on the root
// filesystem.  Get it wrong and the player comes up without its show.
// lsblk (the root device) and file (the filesystem) are stand-ins; /etc/fstab
// is the container's own, put back after.

test.skip(!container, 'rewrites /etc/fstab inside the run-web.sh container');

const FSTAB = '/etc/fstab';
const SAVED = '/tmp/fpp-tests-fstab';
const MEDIA_LINE = '/dev/sda1\t/home/fpp/media\tauto\tdefaults,noatime,nodiratime,nofail\t0\t2 ';
const sh = (s: string) => inPlayer('sh', '-c', s);

let restoreSettings: () => void = () => {};
test.beforeEach(() => {
  restoreSettings = snapshotSettings();
  sh(`cp -p ${FSTAB} ${SAVED} && printf '%s\\n' 'proc /proc proc defaults 0 0' '${MEDIA_LINE}' > ${FSTAB}`);
  // The root filesystem is on mmcblk0p2, as on a Pi booted from its SD card.
  standInCommand('lsblk', "echo 'mmcblk0p2 179:2 0 29G 0 part /'");
});
test.afterEach(() => {
  sh(`mv -f ${SAVED} ${FSTAB}; rm -f /usr/local/bin/lsblk /usr/local/bin/file /tmp/fpp-tests-lsblk.log /tmp/fpp-tests-file.log /tmp/fpp-tests-fs`);
  restoreSettings();
});

// file -sL /dev/<x> answers as for a filesystem of this kind.
function filesystem(kind: string) {
  sh(`printf '%s' '${kind}' > /tmp/fpp-tests-fs`);
  standInCommand('file', 'echo "$2: $(cat /tmp/fpp-tests-fs)"');
}
async function choose(request: any, device: string) {
  const r = await request.put('/api/settings/storageDevice', { data: device, headers: { 'Content-Type': 'text/plain' } });
  expect(r.ok(), await r.text()).toBe(true);
  return sh(`grep 'home/fpp/media' ${FSTAB}`).trim();
}
const line = (dev: string, options: string, fsck: string) => `/dev/${dev}\t/home/fpp/media\tauto\t${options}\t0\t${fsck}`;

for (const [what, answer, options, fsck] of [
  ['ext4', 'Linux rev 1.0 ext4 filesystem data, UUID=0000 (extents) (64bit)', 'defaults,noatime,nodiratime,nofail', '2'],
  ['FAT, as the fpp user, flushed', 'DOS/MBR boot sector, code offset 0x58+2, OEM-ID "mkfs.fat", FAT (32 bit)', 'defaults,noatime,nodiratime,exec,nofail,flush,uid=500,gid=500', '2'],
  ['exFAT, as the fpp user', 'DOS/MBR boot sector', 'defaults,noatime,nodiratime,exec,nofail,uid=500,gid=500', '2'],
  ['BTRFS, compressed and not fsck\'d', 'BTRFS Filesystem label "media", sectorsize 4096, nodesize 16384', 'defaults,noatime,nodiratime,compress=zstd,nofail', '0'],
] as const) {
  test(`a USB drive with ${what.split(',')[0]} is mounted on the media directory${what.includes(',') ? ',' + what.split(',').slice(1).join(',') : ''}`, async ({ request }) => {
    filesystem(answer);
    expect(await choose(request, 'sdb1')).toBe(line('sdb1', options, fsck));
    // Every other line is left alone.
    expect(sh(`grep -c proc ${FSTAB}`).trim()).toBe('1');
  });
}

test('the root device, or --none--, comments the media mount out', async ({ request }) => {
  filesystem('Linux rev 1.0 ext4 filesystem data');
  expect(await choose(request, '--none--')).toMatch(/^#\/dev\/sda1 +\/home\/fpp\/media/);
  sh(`printf '%s\\n' 'proc /proc proc defaults 0 0' '${MEDIA_LINE}' > ${FSTAB}`);
  expect(await choose(request, 'mmcblk0p2')).toMatch(/^#\/dev\/sda1 +\/home\/fpp\/media/);
});

test('a device name is cut to letters and digits before it reaches a command', async ({ request }) => {
  filesystem('Linux rev 1.0 ext4 filesystem data');
  expect(await choose(request, "sd'b1;/x")).toBe(line('sdb1x', 'defaults,noatime,nodiratime,nofail', '2'));
});

// The root device is found by a regular expression made of its name
// (preg_match("/$rootDevice/", $value)), not by comparing names: with the
// root on sda1 (a Pi booted from a USB SSD), choosing that disk's eleventh
// partition, sda11, comments the media mount out instead of mounting it.
// And where lsblk finds no root (an empty pattern matches anything), every
// choice does.  In FUTURE.md.
test('a partition whose name starts with the root device\'s is mounted, not taken for the root', async ({ request }) => {
  standInCommand('lsblk', "echo 'sda1 8:1 0 29G 0 part /'");
  filesystem('Linux rev 1.0 ext4 filesystem data');
  const got = await choose(request, 'sda11');
  test.fail(true, 'the root device is matched as a pattern, not compared (FUTURE.md)');
  expect(got).toBe(line('sda11', 'defaults,noatime,nodiratime,nofail', '2'));
});

test('with no root device found, a chosen drive is still mounted', async ({ request }) => {
  standInCommand('lsblk', 'true');
  filesystem('Linux rev 1.0 ext4 filesystem data');
  const got = await choose(request, 'sdb1');
  test.fail(true, 'an empty root device pattern matches every choice (FUTURE.md)');
  expect(got).toBe(line('sdb1', 'defaults,noatime,nodiratime,nofail', '2'));
});
