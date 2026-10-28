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


def meminfo(total, cma=0, swap=0):
    return (f"MemTotal:       {total} kB\nMemFree:        {total // 2} kB\n"
            f"SwapTotal:      {swap} kB\nCmaTotal:       {cma} kB\n")


def swaps(*entries):
    """/proc/swaps with (name, kind, size kB) entries."""
    return "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" + "".join(
        f"{name}\t\t\t\t{kind}\t\t{size}\t\t0\t\t-2\n" for name, kind, size in entries)


def build_box(sb, cpus, arch, memory, swap_entries):
    """The /proc a build sizes itself from, and uname -m answering `arch`."""
    sb.fake_path("/proc/cpuinfo", "".join(f"processor\t: {i}\n\n" for i in range(cpus)))
    sb.fake_path("/proc/meminfo", memory)
    sb.fake_path("/proc/swaps", swaps(*swap_entries))
    sb.root_file("/usr/local/sbin/uname", f"#!/bin/sh\n[ \"$1\" = -m ] && echo {arch} && exit 0\n"
                                          "exec /usr/bin/uname \"$@\"\n")


# Bash, with FPP's common and functions sourced from the tree under test.
FUNCTIONS = 'PATH=/usr/local/sbin:$PATH; . /opt/fpp/scripts/common; . /opt/fpp/scripts/functions; PATH=/usr/local/sbin:$PATH\n'

ZRAM = ("/dev/zram0", "partition", 245000)


@pytest.mark.parametrize("cpus,arch,memory,swap_entries,jobs", [
    # 4 cores, under 1GB: c86553440 caps it at 3
    (4, "aarch64", meminfo(900000), [], 3),
    # a 1GB Pi 4 with its 512MB CMA pool: 6d790b72f leaves ~200MB, so 1 job
    (4, "aarch64", meminfo(730000, cma=524288), [], 1),
    # a 493MB 32-bit board with only zram: 5dd19628f counts no swap, so 1 job
    (2, "armv7l", meminfo(493000, swap=245000), [ZRAM], 1),
    # the same with 100MB of disk swap: 2 jobs (the control)
    (2, "armv7l", meminfo(493000, swap=345400), [ZRAM, ("/home/fpp/media/tmp/swapfile", "file", 100400)], 2),
], ids=["under-1GB", "cma-pool", "zram-only", "disk-swap"])
def test_build_jobs_fit_the_memory_the_compile_can_use(fppinit, cpus, arch, memory, swap_entries, jobs):
    """ComputeMakeParallelism, the make -j for a build on the device,
    sized from /proc: a 4-core box under 1GB gets 3 jobs; CMA (the Pi's
    GPU pool) is not memory a compile can use; zram is not swap a compile
    can lean on.

    Regressions: c86553440 (a 4-core box with under 1GB got -j4), 6d790b72f
    (a 1GB Pi 4 counted its 512MB CMA pool, got -j3, and cc1plus was
    OOM-killed), 5dd19628f (a 493MB board counted its zram as swap and
    got -j2, which thrashed it)."""
    build_box(fppinit, cpus, arch, memory, swap_entries)
    r = fppinit._run(["bash", "-c", FUNCTIONS + 'echo "jobs: $(ComputeMakeParallelism)"'], timeout=60)
    out = r.stdout + r.stderr
    got = [l.split()[1] for l in out.splitlines() if l.startswith("jobs: ")]
    assert got == [str(jobs)], f"{cpus} cores, {arch}, {memory!r}, swaps {swap_entries}: -j{got}\n{out[-2000:]}"


# compileBinaries up to the build: the steps around it are stubbed, make does
# nothing, an fppd is "running", and fallocate, mkswap and swapon only record.
COMPILE = FUNCTIONS + r"""
for t in make fallocate mkswap swapon; do
    printf '#!/bin/sh\nprintf "%%s\\n" "%s $*" >> /fppinit-calls.log\n' "$t" > /usr/bin/$t
    chmod +x /usr/bin/$t
done
cleanCompiledBinaries() { :; }
populateCCACHE() { :; }
SetupBuildEnv() { BUILD_CPUS=1; }
pgrep() { echo 4242; }
compileBinaries
"""


@pytest.mark.parametrize("swap_entries,made", [
    ([("/dev/zram0", "partition", 415000)], True),  # a Pi Zero 2 W's
    ([ZRAM, ("/var/swap", "file", 409600)], False),
], ids=["zram-only", "disk-swap"])
def test_a_build_on_a_small_board_gets_a_swapfile_unless_it_has_disk_swap(fppinit, swap_entries, made):
    """A build on a board with under 512MB and fppd running makes a
    swapfile for the compile when the board has under 384MB of disk-backed
    swap -- zram doesn't count -- and none when it has enough.

    Regressions: a6e1038d9 (a Pi Zero 2 W's 415MB of zram passed for swap,
    no swapfile was made, and the PCH compile was OOM-killed two runs in
    three) and c86553440 (a swapfile was made however much swap the board
    already had)."""
    build_box(fppinit, 1, "aarch64", meminfo(430000, swap=sum(e[2] for e in swap_entries)), swap_entries)
    r = fppinit._run(["bash", "-c", COMPILE], timeout=120)
    calls = fppinit.calls()
    assert any(c.startswith("make ") for c in calls), f"the build never ran:\n{(r.stdout + r.stderr)[-2000:]}"
    swapons = [c for c in calls if c.startswith("swapon ")]
    assert bool(swapons) == made, f"swaps {swap_entries}: {calls}"
