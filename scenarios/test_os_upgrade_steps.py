"""Pieces of the FPPOS upgrade (SD/upgradeOS-part2.sh), run on their own
against scratch directory trees.

part2 runs from the new image with the running system bind-mounted at /mnt,
and copies the image over it; it can't be run whole outside a real upgrade.
Its steps that decide what survives that copy are taken out of the script
here, as written in the tree under test, and run on a pair of small trees
standing in for the image and the running root.
"""

import mmap
import os
import re
import subprocess

TREE = os.environ.get("FPP_TREE", "")


def part2():
    with open(os.path.join(TREE, "SD", "upgradeOS-part2.sh")) as f:
        return f.read()


def function(name):
    m = re.search(rf"^{name}\(\) \{{\n.*?^\}}$", part2(), re.M | re.S)
    assert m, f"no {name}() in upgradeOS-part2.sh"
    return m.group(0)


def between(start, end):
    src = part2()
    i = src.find(start)
    j = src.find(end, i)
    assert i >= 0 and j > i, f"upgradeOS-part2.sh has no block from {start!r} to {end!r}"
    return src[i:j]


def bash(script, cwd):
    r = subprocess.run(["bash", "-c", script], cwd=cwd, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout + r.stderr


def write(path, content, mtime=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(content if isinstance(content, bytes) else content.encode())
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def dpkg_root(root, packages):
    """A dpkg database with these {name: (version, [files])}, each file's
    list in info/<name>.list."""
    status = ""
    for name, (version, files) in packages.items():
        status += (f"Package: {name}\nStatus: install ok installed\nPriority: optional\n"
                   f"Architecture: all\nVersion: {version}\nMaintainer: fpp-tests\n"
                   f"Description: test\n\n")
        write(os.path.join(root, "var", "lib", "dpkg", "info", f"{name}.list"),
              "".join(f + "\n" for f in files), mtime=1500000000)
    write(os.path.join(root, "var", "lib", "dpkg", "status"), status)


def test_files_of_a_rebuilt_package_are_refreshed_though_rsync_would_skip_them(tmp_path):
    """Before the root rsync, part2 deletes the running system's copy of each
    file whose package changed version in the image but whose size and
    mtime did not (a binNMU keeps both), so rsync copies it fresh; an
    unchanged package's files, and files that differ visibly, are left for
    rsync to judge.

    Regression: 876a2dfee. rsync's size+mtime check skipped those files, so
    the box kept the old bytes -- mp3gain dying against the new libmpg123
    was one, with more in every release.
    """
    new, old = tmp_path / "image", tmp_path / "root"
    T = 1600000000
    for root, rebuilt in ((new, "1.6.2-2+b1"), (old, "1.6.2-2")):
        dpkg_root(str(root), {"fpptest-rebuilt": (rebuilt, ["/usr/bin/fpptest-rebuilt"]),
                              "fpptest-same": ("2.0-1", ["/usr/bin/fpptest-same"])})
    write(str(new / "usr/bin/fpptest-rebuilt"), "new bytes", mtime=T)
    write(str(old / "usr/bin/fpptest-rebuilt"), "old bytes", mtime=T)
    write(str(new / "usr/bin/fpptest-same"), "same", mtime=T)
    write(str(old / "usr/bin/fpptest-same"), "same", mtime=T)
    out = bash(function("refresh_rebuilt_package_files") + f"\nrefresh_rebuilt_package_files {new} {old}\n",
               str(tmp_path))
    assert not (old / "usr/bin/fpptest-rebuilt").exists(), \
        f"the rebuilt package's stale file was kept for rsync to skip:\n{out}"
    assert (old / "usr/bin/fpptest-same").read_text() == "same", out
    assert (new / "usr/bin/fpptest-rebuilt").read_text() == "new bytes", "the image was changed"


def test_force_copied_libraries_get_a_new_inode(tmp_path):
    """part2's force copy of the libraries rsync won't replace cleanly makes
    a new file, so a process that has the old one mapped keeps reading the
    bytes it loaded.

    Regression: db5f6de72. A plain cp -af truncated and rewrote the inode
    fppd had mapped; its relocated pages refaulted as raw file bytes and
    the next dlopen() segfaulted. (part1's fresh-inode pass for images
    built before this fix is not covered here.)
    """
    triple = "fpptest-linux-gnu"
    write(str(tmp_path / f"usr/lib/{triple}/libzip.so.5.5"), b"N" * 4096)
    live = tmp_path / f"mnt/usr/lib/{triple}/libzip.so.5.5"
    write(str(live), b"O" * 4096)
    before = os.stat(live).st_ino
    with open(live, "rb") as f:
        mapped = mmap.mmap(f.fileno(), 4096, prot=mmap.PROT_READ)
    try:
        bash(f"TRIPLE={triple}\n" + function("force_copy_libs") + "\nforce_copy_libs 'libzip.so.*'\n",
             str(tmp_path))
        assert live.read_bytes() == b"N" * 4096, "the library was not copied"
        assert os.stat(live).st_ino != before, "the copy wrote into the inode that was mapped"
        assert mapped[:4096] == b"O" * 4096, "a process's mapping of the old library changed under it"
    finally:
        mapped.close()


def test_the_generated_system_uuid_survives_the_root_copy(tmp_path):
    """/etc/fpp/fpp_uuid -- the identity generated for a board with no
    usable hardware serial -- is saved before the root rsync, which deletes
    it (no image carries one), and restored after it, beside the ssh host
    keys, hostname and machine-id.

    Regression: e45b8a0be. Nothing saved it, so the board took a new
    identity on every OS upgrade.
    """
    mnt = tmp_path / "mnt"
    write(str(mnt / "etc/ssh/ssh_host_ed25519_key"), "key")
    write(str(mnt / "etc/hostname"), "fpp-tests\n")
    write(str(mnt / "etc/machine-id"), "0123456789abcdef0123456789abcdef\n")
    write(str(mnt / "etc/fpp/fpp_uuid"), "8a1d6c2e-0000-4000-8000-fpptests0001\n")
    (tmp_path / "tmp").mkdir()
    save = between("# temporarily copy the ssh keys", "# --- Reconcile")
    # The root rsync, --delete-during, from an image that has no fpp_uuid.
    rsync = ("rm -rf mnt/etc && mkdir -p mnt/etc/ssh mnt/etc/fpp && "
             "echo fpp > mnt/etc/hostname && echo uninitialized > mnt/etc/machine-id\n")
    restore = between("#restore the ssh keys", "#create a file in root")
    out = bash(save + "\n" + rsync + restore, str(tmp_path))
    assert (mnt / "etc/fpp/fpp_uuid").exists(), f"fpp_uuid did not survive the upgrade:\n{out}"
    assert (mnt / "etc/fpp/fpp_uuid").read_text() == "8a1d6c2e-0000-4000-8000-fpptests0001\n"
    assert (mnt / "etc/hostname").read_text() == "fpp-tests\n", "the control: the hostname is restored"
