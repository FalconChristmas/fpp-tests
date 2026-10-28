"""SD/flash_storage.sh, which copies the running install onto another disk:
its preflight, as a dry run onto a loop device (a sparse image, so nothing
is written, under a name the Pi profile takes), in a private mount
namespace with a /dev of its own.

The invariant it exists for is that the boot files are copied from a boot
filesystem it has proven is mounted. Here /boot/firmware is unmounted in
the namespace (and mount made to fail, so the script cannot put it back)
to show the refusal; with it mounted the same dry run passes. The Pi's
bootloader check (rpi-eeprom-update -a, which can stage an update) is
replaced by true in the namespace. The copy and verify phases are not run.

Needs root, a loop device and a Pi (the profile with a separate boot
filesystem): run-local.sh on a device.
"""

import os
import re
import shutil
import subprocess

import pytest

RUN = r"""
SCRIPT=$1; LOOP=$2; UNMOUNT=$3
E=$(command -v rpi-eeprom-update || true)
[ -n "$E" ] && mount --bind /bin/true "$E"
# A /dev of the namespace's own: the target is the loop device under a name the
# Pi profile takes (sdz), beside the boot device's node, which preflight checks.
BOOT=$(findmnt -no SOURCE --first-only /boot/firmware)
node() { mknod -m 660 "$1" b $((0x$(stat -c %t "$2"))) $((0x$(stat -c %T "$2"))); }
mkdir -p /run/flash-dev
node /run/flash-dev/sdz "$LOOP"; node /run/flash-dev/boot "$BOOT"
mount -t tmpfs -o mode=755 tmpfs /dev
mknod -m 666 /dev/null c 1 3; mknod -m 666 /dev/zero c 1 5; mknod -m 666 /dev/urandom c 1 9
mknod -m 666 /dev/random c 1 8
ln -s /proc/self/fd /dev/fd; ln -s /proc/self/fd/0 /dev/stdin
ln -s /proc/self/fd/1 /dev/stdout; ln -s /proc/self/fd/2 /dev/stderr
mv /run/flash-dev/sdz /dev/sdz; mkdir -p "$(dirname "$BOOT")"; mv /run/flash-dev/boot "$BOOT"
if [ "$UNMOUNT" = 1 ]; then
    umount /boot/firmware || exit 90
    mount --bind /bin/false "$(command -v mount)"
fi
bash "$SCRIPT" --dry-run -y sdz
echo "FLASH-RC=$?"
"""


def dry_run(tree, unmount):
    img = None
    loop = None
    try:
        work = os.path.join(os.environ.get("TMPDIR", "/tmp"), "flash-target")
        os.makedirs(work, exist_ok=True)
        img = os.path.join(work, "target.img")
        with open(img, "wb") as f:
            f.truncate(64 * 1024 ** 3)  # sparse: bigger than any root here
        r = subprocess.run(["losetup", "-f", "--show", img], capture_output=True, text=True)
        if r.returncode:
            pytest.skip("cannot attach a loop device: " + r.stderr.strip())
        loop = r.stdout.strip()
        r = subprocess.run(["unshare", "--mount", "--propagation", "private", "sh", "-c", RUN, "sh",
                            os.path.join(tree, "SD", "flash_storage.sh"), loop, "1" if unmount else "0"],
                           capture_output=True, text=True, timeout=300)
        return r.stdout + r.stderr
    finally:
        if loop:
            subprocess.run(["losetup", "-d", loop], capture_output=True)
        if img:
            os.unlink(img)


@pytest.fixture
def tree():
    tree = os.environ.get("FPP_TREE", "")
    if os.geteuid() != 0 or not os.path.exists(os.path.join(tree, "SD", "flash_storage.sh")):
        pytest.skip("needs root and an fpp tree with SD/flash_storage.sh")
    if not shutil.which("losetup"):
        pytest.skip("no losetup")
    model = open("/proc/device-tree/model").read() if os.path.exists("/proc/device-tree/model") else ""
    if "Raspberry Pi" not in model:
        pytest.skip("the boot filesystem check is the Pi profile's")
    if subprocess.run(["mountpoint", "-q", "/boot/firmware"]).returncode:
        pytest.skip("/boot/firmware is not mounted on this device")
    return tree


def test_a_flash_refuses_to_start_without_the_boot_filesystem(tree):
    """With /boot/firmware not mounted, a flash stops in preflight, saying
    there are no boot files to copy, before touching the target; with it
    mounted, the same dry run passes preflight (the control).

    Regression: 5758dd8ef. rpi-clone worked out what to copy from the live
    mount table, so an unmounted /boot/firmware dropped the boot partition
    from the copy and the flash still printed "complete"."""
    mounted = dry_run(tree, unmount=False)
    assert "FLASH-RC=0" in mounted and "Dry run -- stopping" in mounted, \
        f"control: the dry run passes\n{mounted[-3000:]}"

    out = dry_run(tree, unmount=True)
    assert "/boot/firmware is not mounted, so there are no boot files to copy" in out, out[-3000:]
    assert "FLASH-RC=0" not in out and "Dry run -- stopping" not in out, out[-3000:]
    assert "source boot filesystem:" in mounted, mounted[-3000:]


def fixup_sed(profile, target):
    """The sed in profile_<profile>_fixup() that points the copy's boot
    config (its local ${<target>}) at the copy, as the tree under test has
    it."""
    with open(os.path.join(os.environ.get("FPP_TREE", ""), "SD", "flash_storage.sh")) as f:
        src = f.read()
    m = re.search(rf"^profile_{profile}_fixup\(\) \{{\n(.*?)^\}}$", src, re.M | re.S)
    assert m, f"no profile_{profile}_fixup() in flash_storage.sh"
    s = re.search(rf'^\s*(sed -i "s\|root=.*?" "\$\{{{target}\}}")', m.group(1), re.M | re.S)
    assert s, f"no root= rewrite of ${{{target}}} in profile_{profile}_fixup()"
    return s.group(1)


def test_a_flash_points_a_final_root_token_at_the_copy(tmp_path):
    """The copy's cmdline.txt (Pi) and extlinux.conf (BB64) are pointed at
    the copy's partitions when root= or resume= is the line's last token,
    as it often is in the single line of cmdline.txt, as well as mid-line.

    Regression: 99af6a581. The rewrites matched only a token followed by a
    space, so a final root= kept naming the source disk and the copy could
    not boot."""
    cases = [
        ("pi", "cmdline", "console=tty1 rootfstype=ext4 rootwait root=/dev/mmcblk0p2\n",
         "console=tty1 rootfstype=ext4 rootwait root=/dev/sdz2\n"),
        ("pi", "cmdline", "console=tty1 root=PARTUUID=4e0b4d45-02\n", "console=tty1 root=/dev/sdz2\n"),
        ("pi", "cmdline", "root=/dev/mmcblk0p2 rootwait\n", "root=/dev/sdz2 rootwait\n"),  # control
        ("bb64", "extlinux", "    append console=ttyS2 resume=/dev/mmcblk1p2 root=/dev/mmcblk1p3\n"
                             "    append root=/dev/mmcblk1p3 ro resume=/dev/mmcblk1p2\n",
         "    append console=ttyS2 resume=/dev/sdzp2 root=/dev/sdzp3\n"
         "    append root=/dev/sdzp3 ro resume=/dev/sdzp2\n"),
    ]
    for i, (profile, target, before, after) in enumerate(cases):
        path = tmp_path / f"conf{i}"
        path.write_text(before)
        script = f'DSTPART=/dev/sdz DEVICE=sdz {target}={path}\n{fixup_sed(profile, target)}\n'
        r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
        assert r.returncode == 0, r.stdout + r.stderr
        assert path.read_text() == after, f"{profile} {before!r} became {path.read_text()!r}"
