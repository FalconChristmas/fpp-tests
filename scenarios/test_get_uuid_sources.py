"""scripts/get_uuid, the system UUID fppd and the UI report, run from the
tree on files of the scenario's standing in for the hardware it reads: the
CPU serial (/proc/cpuinfo), the device-tree serial, a BeagleBone's own board
EEPROM and dmidecode. The scenario's container markers are pointed away, so
the script takes the hardware branches a real board does."""

import os
import subprocess

import pytest

TREE = os.environ.get("FPP_TREE", "")


def get_uuid(tmp_path, eeprom=None, dt_serial=None, dmi_serial=None, machine_id=None, settings=None, env=None):
    """Run the tree's get_uuid with the given stand-ins (None: absent) and
    no CPU serial, as on a BeagleBone; its output. `env` is added to its
    environment."""
    if not TREE:
        pytest.skip("FPP_TREE is not set")
    with open(os.path.join(TREE, "scripts", "get_uuid")) as f:
        src = f.read()
    # The sources that would otherwise be read from the machine running this.
    for path in ("/proc/cpuinfo", "/proc/device-tree/serial-number", "/sbin/dmidecode", "sudo dmidecode",
                 "/etc/machine-id"):
        assert path in src, f"get_uuid no longer reads {path}, so this test needs a rewrite"
    (tmp_path / "cpuinfo").write_text("processor\t: 0\n")
    files = {"eeprom": eeprom, "serial-number": dt_serial, "machine-id": machine_id, "settings": settings}
    for name, content in files.items():
        if content is not None:
            (tmp_path / name).write_bytes(content)
    dmi = tmp_path / "dmidecode"
    if dmi_serial is not None:
        dmi.write_text(f"#!/bin/sh\nprintf 'System Information\\n\\tSerial Number: {dmi_serial}\\n'\n")
        dmi.chmod(0o755)
    script = tmp_path / "get_uuid"
    script.write_text(src.replace("/proc/cpuinfo", str(tmp_path / "cpuinfo"))
                         .replace("/home/fpp/media/settings", str(tmp_path / "settings"))
                         .replace("/proc/device-tree/serial-number", str(tmp_path / "serial-number"))
                         .replace("/sys/bus/i2c/devices/0-0050/eeprom", str(tmp_path / "eeprom"))
                         .replace("/etc/machine-id", str(tmp_path / "machine-id"))
                         .replace("sudo dmidecode", str(dmi))
                         .replace("/usr/sbin/dmidecode", str(dmi))
                         .replace("/sbin/dmidecode", str(dmi)))
    r = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=30, cwd=tmp_path,
                       env=dict(os.environ, FPPDIR=TREE,
                                FPP_DOCKERENV=str(tmp_path / "no-dockerenv"),
                                FPP_CONTAINERFILE=str(tmp_path / "no-container"),
                                FPP_UUIDFILE=str(tmp_path / "fpp_uuid"),
                                FPP_UUIDMEDIAFILE=str(tmp_path / "media-fpp_uuid"), **(env or {})))
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
    firmware, or be a vendor default) never used its device-tree serial.
    Also 5da51cb21: the device-tree serial as a source (M3-) at all."""
    out, err = get_uuid(tmp_path, dt_serial=b"FPPDT0012345\x00", dmi_serial="DMI98765432")
    assert out == "M3-FPPDT0012345", f"get_uuid gave {out!r}\n{err[-2000:]}"


def test_get_uuid_falls_back_to_the_machine_id(tmp_path):
    """A system with no hardware serial at all (no CPU, device-tree, board
    EEPROM or dmidecode serial) takes systemd's machine-id: M4-<id>.

    Regression: a5e625e50. Such a system went straight to a generated
    UUID."""
    mid = "3f2a9c0e5b7d4e1f8a6c2b9d0e4f7a13"
    out, err = get_uuid(tmp_path, machine_id=f"{mid}\n".encode())
    assert out == f"M4-{mid}", f"get_uuid gave {out!r}\n{err[-2000:]}"


def test_get_uuid_does_not_run_dmidecode_where_it_is_not_installed(tmp_path):
    """A system without dmidecode never has it run (through sudo): no call
    for it reaches sudo.

    Regression: f3e7b7e57. get_uuid ran "sudo dmidecode" unconditionally, so
    a system without the package ran a failing sudo on every call."""
    if not TREE:
        pytest.skip("FPP_TREE is not set")
    with open(os.path.join(TREE, "scripts", "get_uuid")) as f:
        src = f.read()
    for path in ("/sbin/dmidecode", "sudo dmidecode"):
        assert path in src, f"get_uuid no longer reads {path}, so this test needs a rewrite"
    (tmp_path / "cpuinfo").write_text("processor\t: 0\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "sudo.log"
    (bindir / "sudo").write_text(f'#!/bin/sh\necho "$@" >> {log}\nexit 1\n')
    (bindir / "sudo").chmod(0o755)
    script = tmp_path / "get_uuid"
    script.write_text(src.replace("/proc/cpuinfo", str(tmp_path / "cpuinfo"))
                         .replace("/home/fpp/media/settings", str(tmp_path / "settings"))
                         .replace("/proc/device-tree/serial-number", str(tmp_path / "serial-number"))
                         .replace("/sys/bus/i2c/devices/0-0050/eeprom", str(tmp_path / "eeprom"))
                         .replace("/etc/machine-id", str(tmp_path / "machine-id"))
                         .replace("/usr/sbin/dmidecode", str(tmp_path / "no-dmidecode"))
                         .replace("/sbin/dmidecode", str(tmp_path / "no-dmidecode")))
    subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=30, cwd=tmp_path,
                   env=dict(os.environ, FPPDIR=TREE, PATH=f"{bindir}:{os.environ['PATH']}",
                            FPP_DOCKERENV=str(tmp_path / "no-dockerenv"),
                            FPP_CONTAINERFILE=str(tmp_path / "no-container"),
                            FPP_UUIDFILE=str(tmp_path / "fpp_uuid"),
                            FPP_UUIDMEDIAFILE=str(tmp_path / "media-fpp_uuid")))
    calls = log.read_text().splitlines() if log.exists() else []
    assert not [c for c in calls if c.startswith("dmidecode")], f"sudo was asked for dmidecode: {calls}"


def test_get_uuid_takes_the_developer_fpp_uuid_setting_first(tmp_path):
    """A developer's FPP_UUID setting is the UUID, ahead of what the hardware
    says, stripped of the setting file's quoting; settings without it leave
    the hardware's.

    Regression: 24e59c2c9, which added the setting."""
    out, err = get_uuid(tmp_path, dt_serial=b"FPPDT0012345\x00", settings=b'FPP_UUID = "TEST-1234"\n')
    assert out == "TEST-1234", f"get_uuid gave {out!r}\n{err[-2000:]}"
    out, err = get_uuid(tmp_path, dt_serial=b"FPPDT0012345\x00", settings=b'HostName = "x"\n')
    assert out == "M3-FPPDT0012345", f"get_uuid gave {out!r}\n{err[-2000:]}"


def test_a_machine_id_baked_into_an_old_image_is_replaced_not_reported(tmp_path):
    """A board whose machine-id is one an old image shipped (every board
    flashed from it has the same one) gets a fresh machine-id, and reports
    M4-<the new one>; the real dbus copy it was seeded from becomes a link
    to /etc/machine-id.

    Regression: 1c60a33ce. get_uuid reported the image's machine-id, so
    boards from the same image with no hardware serial (a PocketBeagle 2
    with a blank EEPROM) advertised one UUID between them."""
    shared = "941e84aaaa5243b78352e939b8955ce7"  # in the 9.x images
    dbus = tmp_path / "dbus-machine-id"
    dbus.write_text(shared + "\n")
    # sudo and flock as get_uuid runs them, unprivileged: the files are ours
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "sudo").write_text('#!/bin/sh\nexec "$@"\n')
    (bindir / "flock").write_text('#!/bin/sh\nshift\nexec "$@"\n')
    for f in ("sudo", "flock"):
        (bindir / f).chmod(0o755)
    out, err = get_uuid(tmp_path, machine_id=f"{shared}\n".encode(),
                        env={"PATH": f"{bindir}:{os.environ['PATH']}",
                             "FPP_MACHINEID": str(tmp_path / "machine-id"),
                             "FPP_DBUSMACHINEID": str(dbus)})
    assert out != f"M4-{shared}", f"get_uuid reported the image's shared machine-id\n{err[-2000:]}"
    now = (tmp_path / "machine-id").read_text().strip()
    assert now != shared and len(now) == 32, f"machine-id is now {now!r}\n{err[-2000:]}"
    assert out == f"M4-{now}", f"get_uuid gave {out!r} for machine-id {now}\n{err[-2000:]}"
    assert dbus.is_symlink(), "the dbus copy is still a file of its own"
