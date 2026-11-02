"""How copy_settings_to_storage.sh mounts a File Copy drive, read from the
mount command it runs. In the fppinit sandbox mount is a stand-in that
records its arguments and `file` says what is on the drive, so no block
device is needed (test_backup_drive_owner.py checks the real mount's
effect on a loop device). With nothing mounted the script stops right
after the mount, which is all these look at."""

from fppinit import fppinit  # noqa: F401 -- the fixture

SCRIPT = "/opt/fpp/scripts/copy_settings_to_storage.sh"


def mount_calls(sb, fstype_text):
    sb.root_file("/usr/bin/file", f"#!/bin/sh\necho '/dev/sdz1: {fstype_text}'\n")
    r = sb._run(["bash", SCRIPT, "sdz1", "fpp-test", "TOUSB", "none", "no", "no", "Music"])
    out = r.stdout + r.stderr
    calls = [c for c in sb.calls() if c.startswith("mount ")]
    assert calls, f"the script never mounted the drive:\n{out[-2000:]}"
    return calls


def test_a_fat_drive_is_not_mounted_with_the_flush_option(fppinit):
    """A drive that file(1) reports as FAT or DOS is mounted with
    "-t auto", the options it needs, and no "flush".

    Regression: e20c08b91. The mount asked for "flush", which
    failed on exFAT (reported as FAT/DOS by file), so the backup to such a
    drive could not start."""
    for text in ("DOS/MBR boot sector, code offset 0x58+2, OEM-ID \"mkfs.fat\", FAT (32 bit)",
                 "DOS/MBR boot sector, OEM-ID \"EXFAT   \""):
        calls = mount_calls(fppinit, text)
        assert len(calls) == 1, calls
        line = calls[0]
        # The control: this is the mount the FAT branch makes.
        assert "-t auto" in line and "nofail" in line, line
        opts = line.split("-o ")[1].split()[0].split(",")
        assert "flush" not in opts, line
