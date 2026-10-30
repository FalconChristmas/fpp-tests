"""The FPPOS upgrade's boot-partition sync and its identity restore
(SD/upgradeOS-part2.sh), run on their own against scratch directory trees,
as test_os_upgrade_steps.py runs part2's other steps.

The boot sync's commands are taken from the script as written in the tree
under test and pointed at a pair of small trees standing in for the image's
/boot and the running system's. The boot FAT is a separate filesystem on a
real box, so the scratch one is too: a tmpfs mounted in a mount namespace
of the test's own.
"""

import os
import re
import shutil
import subprocess

import pytest

from test_os_upgrade_steps import between, part2, write


def boot_sync_commands():
    """part2's boot rsync lines, Pi/BB64 branch first and then the
    BeagleBone Black's, each with the BOOT_KEEP array it is given (when the
    tree has one)."""
    src = part2()
    start = src.find('logStage "Updating boot filesystem"')
    end = src.find("\nesac", start)
    assert start >= 0 and end > start, "upgradeOS-part2.sh has no boot sync"
    section = src[start:end]
    keep = re.search(r"^BOOT_KEEP=\(.*?\)$", section, re.M | re.S)
    lines = re.findall(r"^\s*(rsync [^\n]*/boot/ /mnt/boot/[^\n]*)$", section, re.M)
    assert len(lines) == 2, f"expected the two boot rsyncs, found {lines}"
    return (keep.group(0) if keep else ""), lines


def sync_boot(tmp_path, line, layout):
    """Run one boot rsync line from image/boot to root/boot, with
    root/boot/firmware a filesystem of its own. `layout` is {path: content}
    under each tree; None in the running system's means "not there"."""
    keep, _ = boot_sync_commands()
    image, root = tmp_path / "image" / "boot", tmp_path / "root" / "boot"
    (image / "firmware").mkdir(parents=True)
    (root / "firmware").mkdir(parents=True)
    script = (f"set -e\nmount -t tmpfs tmpfs {root}/firmware\n"
              f"cp -a {tmp_path}/seed/. {root}/\n"
              f"{keep}\n"
              + line.replace("/boot/ /mnt/boot/", f"{image}/ {root}/") + "\n"
              f"cp -a {root}/. {tmp_path}/after/\n")
    for rel, (new, old) in layout.items():
        if new is not None:
            write(str(image / rel), new)
        if old is not None:
            write(str(tmp_path / "seed" / rel), old)
    (tmp_path / "seed").mkdir(exist_ok=True)
    (tmp_path / "after").mkdir()
    r = subprocess.run(["unshare", "--mount", "--propagation", "private", "bash", "-c", script],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, f"the boot sync failed:\n{line}\n{r.stdout[-2000:]}{r.stderr[-2000:]}"
    after = tmp_path / "after"
    return {rel: ((after / rel).read_text() if (after / rel).is_file() else None) for rel in layout}, line


@pytest.fixture
def rsync():
    if not shutil.which("rsync"):
        pytest.skip("no rsync in this image")
    probe = subprocess.run(["unshare", "--mount", "true"], capture_output=True)
    if probe.returncode:
        pytest.skip("cannot make a mount namespace here")


def test_the_pi_boot_sync_deletes_stale_boot_files_and_keeps_the_users(tmp_path, rsync):
    """The Pi/BB64 boot sync, onto a running system whose boot FAT is its
    own filesystem: a kernel the image doesn't ship is deleted from the
    FAT, the image's kernel replaces the old one, and the user's
    fpp_boot.sh and fpp/ directory there (which fppinit runs and copies in
    on every boot, and no image carries) survive.

    Regression: b192176ca. The rsync passed -x, which also stops rsync's
    deletion at the receiving side's mount points, so nothing on the FAT
    was ever deleted: a kernel_2712.img left behind by an old image made a
    Pi 5 boot a kernel with no modules. Dropping -x alone would then delete
    the user's files, hence the excludes."""
    _, (pi, _) = boot_sync_commands()
    got, line = sync_boot(tmp_path, pi, {
        "firmware/kernel8.img": ("new kernel", "old kernel"),
        "firmware/kernel_2712.img": (None, "stale 16K kernel"),
        "firmware/fpp_boot.sh": (None, "#!/bin/sh\necho user\n"),
        "firmware/fpp/settings": (None, "user settings\n"),
    })
    assert got["firmware/kernel8.img"] == "new kernel", f"{got}\n{line}"
    assert got["firmware/kernel_2712.img"] is None, \
        f"the stale kernel on the boot FAT survived the sync:\n{line}"
    assert got["firmware/fpp_boot.sh"] == "#!/bin/sh\necho user\n", f"the user's fpp_boot.sh was deleted:\n{line}"
    assert got["firmware/fpp/settings"] == "user settings\n", f"the user's fpp/ was deleted:\n{line}"


def test_the_beagle_boot_sync_deletes_stale_files_and_keeps_the_users(tmp_path, rsync):
    """The BeagleBone Black's boot sync, onto a running system with the
    newer layout (kernel files in /boot on the root, a small FAT at
    /boot/firmware): an obsolete file is deleted from each, and the user's
    fpp_boot.sh and fpp/ survive under both spellings of the boot directory
    (fppinit picks /boot/firmware whenever it exists).

    Regression: b192176ca. With -x nothing on the FAT was ever deleted; on
    the layouts without a FAT, -x suppressed nothing and the sync had
    always deleted the user's files."""
    _, (_, bbb) = boot_sync_commands()
    got, line = sync_boot(tmp_path, bbb, {
        "uEnv.txt": ("new uEnv\n", "old uEnv\n"),
        "dtbs/obsolete.dtb": (None, "old dtb"),
        "fpp_boot.sh": (None, "#!/bin/sh\necho root user\n"),
        "fpp/settings": (None, "root user settings\n"),
        "firmware/ID.txt": ("new id\n", "old id\n"),
        "firmware/START.HTM": (None, "obsolete"),
        "firmware/fpp_boot.sh": (None, "#!/bin/sh\necho fat user\n"),
        "firmware/fpp/settings": (None, "fat user settings\n"),
    })
    assert got["uEnv.txt"] == "new uEnv\n" and got["firmware/ID.txt"] == "new id\n", f"{got}\n{line}"
    assert got["dtbs/obsolete.dtb"] is None, f"an obsolete file in /boot survived:\n{line}"
    assert got["firmware/START.HTM"] is None, f"an obsolete file on the boot FAT survived:\n{line}"
    for rel in ("fpp_boot.sh", "fpp/settings", "firmware/fpp_boot.sh", "firmware/fpp/settings"):
        assert got[rel] is not None, f"the user's {rel} was deleted:\n{line}"


KEYS = ("ssh_host_ed25519_key", "ssh_host_ed25519_key.pub", "ssh_host_rsa_key", "ssh_host_rsa_key.pub",
        "ssh_host_ecdsa_key", "ssh_host_ecdsa_key.pub")
UNIT = "etc/systemd/system/multi-user.target.wants/regenerate_ssh_host_keys.service"


def upgrade_identity(tmp_path, device_keys=KEYS, image_keys=KEYS):
    """part2's save of the running Beagle's identity, a stand-in for the root
    rsync that copies a Beagle image over it (first-boot markers and all),
    then the restore and the post-restore steps. Returns (mnt, output)."""
    mnt = tmp_path / "mnt"
    for k in device_keys:
        write(str(mnt / "etc/ssh" / k), f"device {k}\n")
    write(str(mnt / "etc/hostname"), "fpp-tests\n")
    write(str(mnt / "etc/machine-id"), "0123456789abcdef0123456789abcdef\n")
    (tmp_path / "tmp").mkdir()
    save = between("# temporarily copy the ssh keys", "# --- Reconcile")
    # The root rsync, --delete-during, from a Beagle image: its own host
    # keys, the first-boot markers, and sysconf.txt on the boot FAT.
    write(str(tmp_path / "sysconf.txt"), "# sysconf.txt\nuser_name=fpp\nuser_password=falcon\n"
          "  user_name = other\nhostname=fpp-image\nuser_name_extra=keep\n")
    rsync = ("rm -rf mnt/etc mnt/boot && mkdir -p mnt/etc/ssh mnt/etc/bbb.io mnt/boot/firmware "
             "mnt/etc/systemd/system/multi-user.target.wants && "
             + "".join(f"echo image > mnt/etc/ssh/{k} && " for k in image_keys) +
             "touch mnt/etc/bbb.io/ssh_regenerate && echo fpp > mnt/etc/hostname && "
             f"touch mnt/{UNIT} && echo uninitialized > mnt/etc/machine-id && "
             "cp sysconf.txt mnt/boot/firmware/sysconf.txt && cp sysconf.txt mnt/boot/sysconf.txt\n")
    restore = between("#restore the ssh keys", "#create a file in root")
    after = between("touch mnt/fppos_upgraded", '\nif [ "${FPPPLATFORM}" = "Raspberry Pi" ]')
    r = subprocess.run(["bash", "-c", save + "\n" + rsync + restore + after], cwd=tmp_path,
                       capture_output=True, text=True, timeout=60)
    assert "syntax error" not in r.stderr, r.stderr
    return mnt, r.stdout + r.stderr


def test_a_beagle_upgrade_keeps_the_device_identity(tmp_path):
    """After the restore, the Beagle image's first-boot markers are gone:
    /etc/bbb.io/ssh_regenerate (which regenerates the host keys on first
    boot) and sysconf.txt's user_name/user_password lines (which reset the
    fpp user's password), in both boot directories, with the rest of
    sysconf.txt kept; the restored host keys are the device's, and the old
    first-boot key regeneration unit is disabled though the device has no
    DSA key.

    Regression: 949ff22e0. Both markers came through from the image and
    fired on the first boot after the upgrade, wiping the restored host
    keys ("REMOTE HOST IDENTIFICATION HAS CHANGED") and the password; the
    unit was only disabled when ssh_host_dsa_key existed, which no current
    Debian ships."""
    mnt, out = upgrade_identity(tmp_path)
    assert (mnt / "etc/ssh/ssh_host_ed25519_key").read_text() == "device ssh_host_ed25519_key\n", \
        f"the control: the device's keys are restored\n{out}"
    assert not (mnt / "etc/bbb.io/ssh_regenerate").exists(), \
        f"the image's ssh_regenerate marker was left to wipe the restored keys on first boot:\n{out}"
    for sysconf in ("boot/firmware/sysconf.txt", "boot/sysconf.txt"):
        text = (mnt / sysconf).read_text()
        assert not re.search(r"^\s*(user_name|user_password)\s*=", text, re.M), \
            f"{sysconf} still resets the user on first boot:\n{text}"
        assert "hostname=fpp-image\n" in text and "user_name_extra=keep\n" in text, text
    assert not (mnt / UNIT).exists(), f"the first-boot key regeneration unit was left enabled:\n{out}"


def test_a_beagle_upgrade_without_the_keys_says_so(tmp_path):
    """With no host keys to restore, the upgrade log says clients will see a
    changed host key, and the first-boot regeneration unit is left alone.

    Regression: 949ff22e0 (the warning is new there)."""
    mnt, out = upgrade_identity(tmp_path, device_keys=(), image_keys=())
    assert "SSH host keys were not restored" in out, out
