"""System scripts that act on swap and on removable storage: upgrade 141
(in the fppinit sandbox, fppinit.py) and the File Copy backup to a FAT
drive (copy_settings_to_storage.sh), which needs a real block device: a
loop device over a small FAT image in the test's temporary directory,
detached afterwards.
The script runs in a private mount namespace with a /dev of its own, so its
mount never shows outside it. Needs root (run-local.sh).
"""

import os
import shutil
import subprocess
import tempfile

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

DROPIN = "/etc/rpi/swap.conf.d/10-fpp-zram-only.conf"


def test_upgrade_141_pins_rpi_swap_to_plain_zram(fppinit):
    """Where rpi-swap is installed, upgrade 141 adds a drop-in setting
    Mechanism=zram; with the drop-in already there it changes nothing, and
    where rpi-swap isn't installed it writes nothing and still succeeds.

    Feature: ce72c160e. rpi-swap's "zram+file" default puts a loop device
    over /var/swap on the boot path, whose udev wait can block the boot
    forever; plain zram drops it. (The boot hang itself is a udev race and
    isn't reproduced here.)"""
    fppinit.root_file("/etc/rpi/swap.conf", "[Main]\nMechanism=auto\n")
    fppinit.root_file(DROPIN, None)
    r = fppinit._run(["/opt/fpp/upgrade/141/upgrade.sh"])
    out = r.stdout + r.stderr
    assert r.returncode == 0, f"141 exited {r.returncode}:\n{out[-3000:]}"
    dropin = fppinit.written(DROPIN)
    assert dropin is not None, f"no drop-in written:\n{out[-3000:]}"
    lines = [l.strip() for l in dropin.splitlines()]
    assert "[Main]" in lines and "Mechanism=zram" in lines, dropin
    assert fppinit.written("/etc/rpi/swap.conf") == "[Main]\nMechanism=auto\n", "swap.conf was edited"

    fppinit.root_file(DROPIN, "# kept\n[Main]\nMechanism=zram\n")
    r = fppinit._run(["/opt/fpp/upgrade/141/upgrade.sh"])
    assert r.returncode == 0, r.stdout + r.stderr
    with open(os.path.join(fppinit.upper, DROPIN.lstrip("/"))) as f:
        assert f.read() == "# kept\n[Main]\nMechanism=zram\n", "an existing drop-in was rewritten"

    fppinit.root_file("/etc/rpi/swap.conf", None)
    fppinit.root_file(DROPIN, None)
    fppinit.root_file("/etc/rpi/swap.conf.d", None)
    r = fppinit._run(["/opt/fpp/upgrade/141/upgrade.sh"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert fppinit.written(DROPIN) is None, r.stdout


NAME = "Café Noël – ñ.mp3"  # not representable in the kernel's default FAT charset (ascii)

# Inside a private mount namespace: a /dev holding only what the script needs
# plus the loop device under a name it accepts (sdz1), its own /tmp, and the
# media directory it copies from replaced by the test's, which also gets a
# copy of the script: the test's own directory, under /tmp, is covered next.
RUN = r"""
set -e
LOOP=$1; MEDIA=$2; SCRIPT=$3
MAJ=$(stat -c '%t' "$LOOP"); MIN=$(stat -c '%T' "$LOOP")
mount -t tmpfs -o mode=755 tmpfs /dev
mknod -m 666 /dev/null c 1 3; mknod -m 666 /dev/zero c 1 5; mknod -m 666 /dev/urandom c 1 9
mknod -m 660 /dev/sdz1 b $((0x$MAJ)) $((0x$MIN))
ln -s /proc/self/fd /dev/fd; ln -s /proc/self/fd/0 /dev/stdin
ln -s /proc/self/fd/1 /dev/stdout; ln -s /proc/self/fd/2 /dev/stderr
mkdir -p /home/fpp/media
mount --bind "$MEDIA" /home/fpp/media
cp "$SCRIPT" /home/fpp/media/.copy.sh
mount -t tmpfs -o mode=1777 tmpfs /tmp
set +e
bash /home/fpp/media/.copy.sh sdz1 fpp-test TOUSB none no no Music
echo "SCRIPT-RC=$?"
"""


def test_a_fat_backup_keeps_non_ascii_file_names(tmp_path):
    """File Copy to a FAT drive copies a music file whose name has
    accented letters and a dash outside ASCII, under that same name, and
    reports success.

    Regression: 029227635. The drive was mounted without utf8, so the
    kernel's default FAT charset (ascii on FPP's kernels) refused the name:
    rsync failed on the file and the backup was reported failed.
    Device only (a loop device and vfat): run with run-local.sh."""
    tree = os.environ.get("FPP_TREE", "")
    script = os.path.join(tree, "scripts", "copy_settings_to_storage.sh")
    if os.geteuid() != 0 or not os.path.exists(script):
        pytest.skip("needs root and an fpp tree")
    for tool in ("losetup", "mkfs.vfat", "rsync", "file", "mknod"):
        if not shutil.which(tool):
            pytest.skip(f"no {tool}")
    if subprocess.run(["id", "fpp"], capture_output=True).returncode:
        pytest.skip("no fpp user")
    work = str(tmp_path)
    loop = None
    try:
        img = os.path.join(work, "fat.img")
        with open(img, "wb") as f:
            f.truncate(16 * 1024 * 1024)
        subprocess.run(["mkfs.vfat", "-n", "FPPTEST", img], check=True, capture_output=True)
        r = subprocess.run(["losetup", "-f", "--show", img], capture_output=True, text=True)
        if r.returncode:
            pytest.skip("cannot attach a loop device: " + r.stderr.strip())
        loop = r.stdout.strip()
        media = os.path.join(work, "media")
        os.makedirs(os.path.join(media, "music"))
        with open(os.path.join(media, "music", NAME), "wb") as f:
            f.write(b"not really an mp3\n")
        r = subprocess.run(["unshare", "--mount", "--propagation", "private", "sh", "-c", RUN,
                            "sh", loop, media, script], capture_output=True, text=True, timeout=120)
        out = r.stdout + r.stderr
        assert "SCRIPT-RC=0" in out and "BACKUP COMPLETE" in out, out[-3000:]

        # Read the drive back, with the charset that can show the name.
        check = tempfile.mkdtemp(dir=work)
        r = subprocess.run(["unshare", "--mount", "--propagation", "private", "sh", "-c",
                            'mount -o ro,utf8 "$1" "$2" && ls -1 "$2/fpp-test/music"',
                            "sh", loop, check], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stdout + r.stderr
        assert r.stdout.splitlines() == [NAME], f"on the drive: {r.stdout!r}\n{out[-2000:]}"
    finally:
        if loop:
            subprocess.run(["losetup", "-d", loop], capture_output=True)
