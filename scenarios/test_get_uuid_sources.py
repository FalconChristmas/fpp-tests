"""scripts/get_uuid, the system UUID fppd and the UI report, run from the
tree on files of the scenario's standing in for the hardware it reads: the
CPU serial (/proc/cpuinfo), the device-tree serial, a BeagleBone's own board
EEPROM and dmidecode. The scenario's container markers are pointed away, so
the script takes the hardware branches a real board does."""

import os
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")


def get_uuid(tmp_path, eeprom=None, dt_serial=None, dmi_serial=None):
    """Run the tree's get_uuid with the given stand-ins (None: absent) and
    no CPU serial, as on a BeagleBone; its output."""
    if not TREE:
        pytest.skip("FPP_TREE is not set")
    with open(os.path.join(TREE, "scripts", "get_uuid")) as f:
        src = f.read()
    # The sources that would otherwise be read from the machine running this.
    for path in ("/proc/cpuinfo", "/proc/device-tree/serial-number", "/sbin/dmidecode", "sudo dmidecode"):
        assert path in src, f"get_uuid no longer reads {path}, so this test needs a rewrite"
    (tmp_path / "cpuinfo").write_text("processor\t: 0\n")
    files = {"eeprom": eeprom, "serial-number": dt_serial}
    for name, content in files.items():
        if content is not None:
            (tmp_path / name).write_bytes(content)
    dmi = tmp_path / "dmidecode"
    if dmi_serial is not None:
        dmi.write_text(f"#!/bin/sh\nprintf 'System Information\\n\\tSerial Number: {dmi_serial}\\n'\n")
        dmi.chmod(0o755)
    script = tmp_path / "get_uuid"
    script.write_text(src.replace("/proc/cpuinfo", str(tmp_path / "cpuinfo"))
                         .replace("/proc/device-tree/serial-number", str(tmp_path / "serial-number"))
                         .replace("/sys/bus/i2c/devices/0-0050/eeprom", str(tmp_path / "eeprom"))
                         .replace("sudo dmidecode", str(dmi))
                         .replace("/usr/sbin/dmidecode", str(dmi))
                         .replace("/sbin/dmidecode", str(dmi)))
    r = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=30, cwd=tmp_path,
                       env=dict(os.environ, FPPDIR=TREE,
                                FPP_DOCKERENV=str(tmp_path / "no-dockerenv"),
                                FPP_CONTAINERFILE=str(tmp_path / "no-container"),
                                FPP_UUIDFILE=str(tmp_path / "fpp_uuid"),
                                FPP_UUIDMEDIAFILE=str(tmp_path / "media-fpp_uuid")))
    return r.stdout.strip(), r.stderr


def test_get_uuid_takes_a_pocketbeagle2_board_serial(tmp_path):
    """A PocketBeagle 2 (no CPU or device-tree serial) gets its UUID from
    the serial in its board EEPROM: M5-<serial>.

    Regression: 87b6e674b. get_uuid had no reader for the board EEPROM, so a
    PocketBeagle 2 fell through to machine-id or a generated UUID, which an
    OS reflash replaces."""
    serial = "5024PB2A0012BC34"
    out, err = get_uuid(tmp_path, eeprom=b"\xaa" * 40 + serial.encode() + b"\xff" * 16)
    assert out == f"M5-{serial}", f"get_uuid gave {out!r}\n{err[-2000:]}"


def test_get_uuid_prefers_the_device_tree_serial_to_dmidecode(tmp_path):
    """A board with both a device-tree serial and a dmidecode serial number
    gets its UUID from the device tree: M3-<serial>.

    Regression: 87b6e674b. dmidecode was asked first, so a board whose
    firmware also answers dmidecode (with a value that can change with the
    firmware, or be a vendor default) never used its device-tree serial."""
    out, err = get_uuid(tmp_path, dt_serial=b"FPPDT0012345\x00", dmi_serial="DMI98765432")
    assert out == "M3-FPPDT0012345", f"get_uuid gave {out!r}\n{err[-2000:]}"
