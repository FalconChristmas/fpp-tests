"""File Copy backup to a FAT drive (copy_settings_to_storage.sh): who owns
what it writes. FAT keeps no owners, so the script gives the drive one when
it mounts it; that has to be the fpp user as this box has it.

As in test_storage_and_swap_scripts.py, the drive is a loop device over a
small FAT image, and the script runs in a private mount namespace with a
/dev of its own. Its umount is a no-op there, so the drive is still
mounted, as the script mounted it, when the scenario looks. Needs root and
loop devices (run-local.sh on a device).
"""

import os
import pwd
import shutil
import subprocess

import pytest

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
mount --bind /bin/true "$(command -v umount)"
set +e
bash /home/fpp/media/.copy.sh sdz1 fpp-test TOUSB none no no Music
echo "SCRIPT-RC=$?"
echo "OWNER=$(stat -c '%u:%g' /tmp/smnt/fpp-test/music/song.mp3)"
"""


def test_a_fat_backup_belongs_to_the_fpp_user_of_this_box(tmp_path):
    """The fpp user here is not uid 500 (current images use 1000): File
    Copy to a FAT drive mounts it as fpp's real uid and gid, so what it
    writes there is fpp's.

    Regression: 1c16efe6b. The mount said uid=500,gid=500, which on a box
    whose fpp user is 1000 left the backup owned by nobody fpp is."""
    tree = os.environ.get("FPP_TREE", "")
    script = os.path.join(tree, "scripts", "copy_settings_to_storage.sh")
    if os.geteuid() != 0 or not os.path.exists(script):
        pytest.skip("needs root and an fpp tree")
    for tool in ("losetup", "mkfs.vfat", "rsync", "file", "mknod"):
        if not shutil.which(tool):
            pytest.skip(f"no {tool}")
    try:
        fpp = pwd.getpwnam("fpp")
    except KeyError:
        pytest.skip("no fpp user")
    if fpp.pw_uid == 500:
        pytest.skip("the fpp user is uid 500 here, which the old hardcoded mount also gave")
    loop = None
    try:
        img = os.path.join(str(tmp_path), "fat.img")
        with open(img, "wb") as f:
            f.truncate(16 * 1024 * 1024)
        subprocess.run(["mkfs.vfat", "-n", "FPPTEST", img], check=True, capture_output=True)
        r = subprocess.run(["losetup", "-f", "--show", img], capture_output=True, text=True)
        if r.returncode:
            pytest.skip("cannot attach a loop device: " + r.stderr.strip())
        loop = r.stdout.strip()
        media = os.path.join(str(tmp_path), "media")
        os.makedirs(os.path.join(media, "music"))
        with open(os.path.join(media, "music", "song.mp3"), "wb") as f:
            f.write(b"not really an mp3\n")
        r = subprocess.run(["unshare", "--mount", "--propagation", "private", "sh", "-c", RUN,
                            "sh", loop, media, script], capture_output=True, text=True, timeout=120)
        out = r.stdout + r.stderr
        assert "SCRIPT-RC=0" in out and "BACKUP COMPLETE" in out, out[-3000:]
        assert f"OWNER={fpp.pw_uid}:{fpp.pw_gid}" in out, out[-3000:]
    finally:
        if loop:
            subprocess.run(["losetup", "-d", loop], capture_output=True)
