"""part2's judgement of its own copies (SD/upgradeOS-part2.sh): checkCopy
on each rsync's exit status and error lines, and the end of the script,
which turns a failed copy into exit 2 and a "do not reboot" instead of a
reboot into a half-written OS. Run on their own, as test_os_upgrade_steps.py
runs part2's other steps.
"""

import os
import subprocess

import pytest

from test_os_upgrade_steps import between, part2, write

FAT_CHOWN = 'rsync: [generator] chown "/mnt/boot/firmware/config.txt" failed: Operation not permitted (1)'
FAT_CHOWN_RECEIVER = 'rsync: [Receiver] chown "/mnt/boot/firmware/.cmdline.txt.Ab12" failed: Operation not permitted (1)'
FAT_XATTR = 'rsync: [receiver] rsync_xal_set: lsetxattr("/mnt/boot/firmware/x","user.a") failed: Operation not supported (95)'
BUSY = "rsync: [generator] delete_file: rmdir(opt/usbstick) failed: Device or resource busy (16)"
IMMUTABLE = 'rsync: [receiver] rename "/mnt/usr/share/common-licenses/.GPL-3.hCpkHK" -> "usr/share/common-licenses/GPL-3": Operation not permitted (1)'
# Mentions chown in the path, but is not FAT noise: the pattern is anchored.
RENAME_CHOWN = 'rsync: [receiver] rename "/mnt/usr/lib/chown/.x.AbC" -> "usr/lib/chown/x": Operation not permitted (1)'
NO_SPACE = 'rsync: [receiver] write failed on "/mnt/usr/lib/libfoo.so": No space left on device (28)'


def copy_checks():
    """COPY_FAILED, the COPY_* patterns and checkCopy(), as written."""
    return between('COPY_FAILED=""', '\nlogStage "Updating boot filesystem"')


def check(tmp_path, rc, lines, strict=""):
    """checkCopy on one copy; returns (failed, output)."""
    errs = tmp_path / "rsync.err"
    errs.write_text("".join(l + "\n" for l in lines))
    script = (copy_checks() + f'\ncheckCopy "boot partition" {rc} {errs} {strict}\n'
              'echo "COPY_FAILED=[${COPY_FAILED}]"\n')
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    return "COPY_FAILED=[]" not in r.stdout, r.stdout + r.stderr


@pytest.mark.parametrize("rc,lines,strict,fails", [
    (0, [], "", False),
    (24, [], "", False),                                # source files vanished
    (23, [FAT_CHOWN, FAT_CHOWN_RECEIVER], "", False),   # a FAT can't hold owners
    (23, [FAT_XATTR], "", False),
    (23, [BUSY], "strict", False),                      # a mount point the image lacks
    (23, [FAT_CHOWN], "strict", True),                  # the root copy has no FAT excuse
    (23, [FAT_CHOWN, IMMUTABLE], "", True),
    (23, [RENAME_CHOWN], "", True),
    (23, [NO_SPACE], "", True),
    (23, [], "", True),                                 # rc 23 with nothing said proves nothing
    (11, [], "", True),
    (12, [FAT_CHOWN], "", True),
])
def test_check_copy_passes_only_what_a_good_copy_prints_anyway(tmp_path, rc, lines, strict, fails):
    """checkCopy passes rc 0 and 24, and rc 23 only when every error line
    is harmless: what a FAT boot partition always prints (not for the root
    copy, "strict"), or a mount point rsync cannot delete. Anything else,
    or an rc 23 with no error lines to judge, marks the copy failed.

    Regression: cd89a13bb. part2 never looked at rsync's exit status, so a
    copy that wrote only part of the new OS ended in a reboot into it."""
    failed, out = check(tmp_path, rc, lines, strict)
    assert failed is fails, f"rc={rc} strict={strict!r} {lines}:\n{out}"
    if fails:
        assert "ERROR: copying the boot partition failed" in out, out


def test_check_copy_names_a_busy_mount_point_it_left(tmp_path):
    """A busy mount point passes with a NOTE naming it, not silently."""
    failed, out = check(tmp_path, 23, [BUSY], "strict")
    assert not failed, out
    assert "NOTE: opt/usbstick is a mount point; left as it is" in out, out


def finish(tmp_path, copy_failed, parent_checks_rc):
    """The end of part2 with COPY_FAILED as given, run from a parent bash
    script standing in for part1 (with or without its PART2RC check, which
    part2 reads through the parent's fd 255). Returns (rc, output)."""
    write(str(tmp_path / "rsync-root.err"), IMMUTABLE + "\n")
    write(str(tmp_path / "rsync-boot.err"), FAT_CHOWN + "\n" + NO_SPACE + "\n")
    src = part2()
    i = src.find('\nif [ -n "${COPY_FAILED}" ]; then')
    assert i >= 0, "upgradeOS-part2.sh has no failed-copy ending"
    child = (copy_checks() + f'\nCOPY_FAILED="{copy_failed}"\n'
             + src[i:].replace("/tmp/rsync-", f"{tmp_path}/rsync-"))
    write(str(tmp_path / "part2.sh"), child)
    parent = "bash part2.sh\nPART2RC=$?\nexit $PART2RC\n" if parent_checks_rc else "bash part2.sh\nexit $?\n"
    write(str(tmp_path / "part1.sh"), parent)
    r = subprocess.run(["bash", "part1.sh"], cwd=tmp_path, capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout + r.stderr


def test_a_failed_copy_exits_2_and_says_not_to_reboot(tmp_path):
    """With a failed copy part2 lists what was not copied (the root's errors
    as rsync wrote them, the boot's less its FAT noise), says not to reboot,
    and exits 2, which part1 from 10.3 on takes as "do not reboot".

    Regression: cd89a13bb."""
    rc, out = finish(tmp_path, "boot partition, root filesystem", parent_checks_rc=True)
    assert rc == 2, out
    assert "the OS copy is INCOMPLETE (boot partition, root filesystem)" in out, out
    assert "GPL-3" in out and "No space left on device" in out, out
    assert "config.txt" not in out, f"the boot partition's FAT noise was listed:\n{out}"
    assert "do NOT reboot" in out, out
    assert "reboots by itself" not in out, \
        f"told the user their part1 reboots anyway, though it checks PART2RC:\n{out}"


def test_a_failed_copy_under_an_old_part1_says_it_will_reboot_anyway(tmp_path):
    """Under a part1 that ignores part2's exit status (10.2 and older),
    part2 says the box reboots anyway, and what to do if it does not come
    back."""
    rc, out = finish(tmp_path, "root filesystem", parent_checks_rc=False)
    assert rc == 2, out
    assert "reboots by itself" in out, out


def test_a_good_copy_exits_0(tmp_path):
    rc, out = finish(tmp_path, "", parent_checks_rc=True)
    assert rc == 0 and "INCOMPLETE" not in out, out
