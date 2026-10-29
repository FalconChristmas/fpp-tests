"""An exFAT storage drive, for real: the Storage tab's format to exFAT
(scripts/format_storage.sh) and the mount options the storageDevice setting
saves for it (www/api/controllers/settings.php, PutSetting), against the
kernel's own exfat driver.

The drive is a loop device over a small image with an MBR partition table,
seen as /dev/sdz (and its partition /dev/sdz1) in a private mount namespace
with a /dev of its own; /etc is an overlay there, so the fstab line the
setting writes lands in a scratch layer, and mount then reads it from
/etc/fstab as the boot does. Needs root, loop devices, sfdisk, mkfs.exfat
and the exfat module: run with run-local.sh on a device.
web/tests/storage-format-flash.spec.ts drives the same format from the page
with stand-in tools.
"""

import os
import pwd
import re
import shutil
import subprocess
import time

import pytest

TREE = os.environ.get("FPP_TREE", "")

DEVS = r"""
# /dev/sdz and /dev/sdz1 are links into the real /dev, kept at another
# path: a loop device's partition gets a new device number each time its
# table is re-read (sfdisk does), where a real disk's keeps its own.
mkdir -p "$WORK/hostdev"; mount --bind /dev "$WORK/hostdev"
mount -t tmpfs -o mode=755 tmpfs /dev
mknod -m 666 /dev/null c 1 3; mknod -m 666 /dev/zero c 1 5; mknod -m 666 /dev/urandom c 1 9
ln -s /proc/self/fd /dev/fd
ln -s "$WORK/hostdev/${LOOPDEV#/dev/}" /dev/sdz; ln -s "$WORK/hostdev/${PART#/dev/}" /dev/sdz1
"""

FORMAT = r"""
set -e
LOOPDEV=$1; PART=$2; WORK=$3; TREE=$4
"""+DEVS+r"""set +e
bash "$TREE/scripts/format_storage.sh" exFAT sdz1
echo "SCRIPT-RC=$?"
echo "PARTTYPE=$(sfdisk --part-type /dev/sdz 1)"
echo "FSTYPE=$(blkid -o value -s TYPE /dev/sdz1)"
"""

# The storageDevice branch of PutSetting(), taken out of the tree's
# settings.php as it is and run on its own (the rest needs Apache), with
# GetFPPUserIds() from the tree's common.php where it has one.
DRIVER = r"""<?php
$tree = getenv('FPP_TREE');
$src = file_get_contents("$tree/www/api/controllers/settings.php");
$start = '} else if ($setting == "storageDevice") {';
$i = strpos($src, $start);
$j = strpos($src, '} else if ($setting ==', $i + strlen($start));
if ($i === false || $j === false) { fwrite(STDERR, "no storageDevice branch\n"); exit(2); }
$common = file_get_contents("$tree/www/common.php");
if (preg_match('/^function GetFPPUserIds\(\).*?^}/ms', $common, $m)) { eval($m[0]); }
$settings = array('BeaglePlatform' => false);
$SUDO = '';
$setting = 'storageDevice';
$value = $argv[1];
eval(substr($src, $i + strlen($start), $j - $i - strlen($start)));
"""

SAVE_AND_MOUNT = r"""
set -e
LOOPDEV=$1; PART=$2; WORK=$3; DRIVER=$4
mkdir -p "$WORK/etc-upper" "$WORK/etc-work"
mount -t overlay overlay -o lowerdir=/etc,upperdir="$WORK/etc-upper",workdir="$WORK/etc-work" /etc
# An FPP image's fstab has the media line commented out until a drive is picked.
printf '/dev/root / auto defaults 0 1\n#/dev/sda1    /home/fpp/media  auto    defaults,nofail 0 0\n' > /etc/fstab
"""+DEVS+r"""set +e
PATH="$WORK/bin:$PATH" php "$DRIVER" sdz1
echo "DRIVER-RC=$?"
echo "FSTAB=$(grep 'home/fpp/media' /etc/fstab)"
mkdir -p /home/fpp/media
mount /home/fpp/media
echo "MOUNT-RC=$?"
echo "OPTIONS=$(findmnt -no OPTIONS /home/fpp/media)"
su -s /bin/sh fpp -c 'echo fpp-tests > /home/fpp/media/fpp-tests-owned'
echo "OWNER=$(stat -c %u:%g /home/fpp/media/fpp-tests-owned)"
umount /home/fpp/media
"""


@pytest.fixture
def drive(tmp_path):
    """A 64MB image with one partition, on a loop device with partition
    scanning: (loop device, its first partition)."""
    if os.geteuid() != 0 or not os.path.exists(os.path.join(TREE, "scripts", "format_storage.sh")):
        pytest.skip("needs root and an fpp tree")
    for tool in ("losetup", "sfdisk", "mkfs.exfat", "blkid", "mknod", "unshare", "php"):
        if not shutil.which(tool):
            pytest.skip(f"no {tool}")
    if subprocess.run(["modprobe", "-n", "exfat"], capture_output=True).returncode and \
            "exfat" not in open("/proc/filesystems").read():
        pytest.skip("no exfat filesystem in this kernel")
    img = tmp_path / "drive.img"
    with open(img, "wb") as f:
        f.truncate(64 * 1024 * 1024)
    # One Linux partition, as a drive fresh from another computer might have.
    subprocess.run(["sfdisk", "-q", str(img)], input="label: dos\nstart=2048, type=83\n",
                   text=True, check=True, capture_output=True)
    r = subprocess.run(["losetup", "-f", "-P", "--show", str(img)], capture_output=True, text=True)
    if r.returncode:
        pytest.skip("cannot attach a loop device: " + r.stderr.strip())
    loop = r.stdout.strip()
    part = loop + "p1"
    try:
        for _ in range(50):
            if os.path.exists(part):
                break
            time.sleep(0.1)
        if not os.path.exists(part):
            pytest.skip(f"no partition device {part} for the loop device")
        yield loop, part
    finally:
        subprocess.run(["losetup", "-d", loop], capture_output=True)


def ns(script, *args, timeout=120):
    r = subprocess.run(["unshare", "--mount", "--propagation", "private", "bash", "-c", script, "bash", *args],
                       capture_output=True, text=True, timeout=timeout)
    return r.stdout + r.stderr


def field(out, name):
    m = re.search(rf"^{name}=(.*)$", out, re.M)
    return m.group(1).strip() if m else None


def test_a_format_to_exfat_types_the_partition_07_and_makes_an_exfat_filesystem(drive, tmp_path):
    """format_storage.sh exFAT sdz1 retypes partition 1 of /dev/sdz as 07
    (exFAT/NTFS) and makes an exFAT filesystem on it, which the kernel
    then recognises.

    Feature: 23add459e ("Ability to format devices to exFAT"). There was no
    exFAT case: the script formatted nothing.
    """
    loop, part = drive
    out = ns(FORMAT, loop, part, str(tmp_path), TREE)
    assert field(out, "SCRIPT-RC") == "0", out[-3000:]
    assert field(out, "PARTTYPE") == "7", out[-3000:]
    assert field(out, "FSTYPE") == "exfat", out[-3000:]


def test_the_media_drive_line_saved_for_an_exfat_drive_mounts_it_for_fpp(drive, tmp_path):
    """Picking an exFAT partition as the storage device writes a fstab line
    whose options the kernel's exfat driver accepts: mount, reading that
    line as the boot does, mounts the drive, owned by the fpp user.

    Regression: 6cfbd6089 (#1633). The exFAT options carried "flush" and
    "nonempty", which exfat refuses ("Unknown parameter 'flush'"), so the
    media drive never mounted and FPP ran on the SD card's media folder.
    (Their uid=500,gid=500, re-added by 23add459e, are the fpp user's own
    ids since 1c16efe6b.)
    """
    loop, part = drive
    subprocess.run(["mkfs.exfat", "-L", "FPPTEST", part], check=True, capture_output=True)
    driver = tmp_path / "driver.php"
    driver.write_text(DRIVER)
    # The branch finds the root device with `lsblk -l | grep " /$"`, which in
    # run-local.sh's namespaces (an overlay root) finds none -- and an empty
    # root device matches every partition. Answer as an SD-booted player.
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "lsblk").write_text("#!/bin/sh\necho 'mmcblk0p2 179:2 0 29G 0 part /'\n")
    (tmp_path / "bin" / "lsblk").chmod(0o755)
    out = ns(SAVE_AND_MOUNT, loop, part, str(tmp_path), str(driver))
    assert field(out, "DRIVER-RC") == "0", out[-3000:]
    fstab = field(out, "FSTAB") or ""
    assert fstab.split()[:3] == ["/dev/sdz1", "/home/fpp/media", "auto"], out[-3000:]
    assert field(out, "MOUNT-RC") == "0", f"the saved line did not mount:\n{out[-3000:]}"
    fpp = pwd.getpwnam("fpp")
    assert field(out, "OWNER") == f"{fpp.pw_uid}:{fpp.pw_gid}", out[-3000:]
