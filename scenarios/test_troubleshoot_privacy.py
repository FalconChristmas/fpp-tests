"""The Display EDID troubleshooting command keeps a display's unique IDs out
of Diagnostic Reports (#3135).

A display's EDID carries its serial number twice (a 32-bit field and a
"Display Product Serial Number" string), its week and year of manufacture,
and often a unit serial or asset tag as an "Alphanumeric Data String". The
Troubleshooting page shows all of it, so the command is marked pii; a
Diagnostic Report runs its manualCrashReportCmd, which must drop every one
of them and still say what the display is and what it can do.

Runs the commands exactly as www/troubleshoot-commands.json declares them,
on a made-up EDID, with /sys/class/drm pointed at a scratch directory.

Regression: fpp 54bfd0838, which added the command. Its first redaction,
grep -v serial, let the Alphanumeric Data String through (verified red).
"""

import json
import os
import shutil
import subprocess

import pytest

SERIAL = 0x0BADF00D
SERIAL_TEXT = "SN-TEST-1234"
ASSET_TAG = "ASSET-TAG-99"
NAME = "FPPTESTMON"
SYSFS = "/sys/class/drm/card*-*/"


def descriptor(tag, text):
    body = text.encode()[:13]
    if len(body) < 13:
        body += b"\n" + b" " * (12 - len(body))
    return bytes([0, 0, 0, tag, 0]) + body


def make_edid():
    """A 1920x1080 EDID 1.4 base block from manufacturer "FPP", with a
    serial in both places, an asset tag and a 2019 manufacture date."""
    e = bytearray(b"\x00\xff\xff\xff\xff\xff\xff\x00")
    e += bytes([0x1A, 0x10, 0x34, 0x12]) + SERIAL.to_bytes(4, "little")
    e += bytes([12, 2019 - 1990, 1, 4, 0x80, 52, 29, 0x78, 0x0A])
    e += bytes([0xEE, 0x91, 0xA3, 0x54, 0x4C, 0x99, 0x26, 0x0F, 0x50, 0x54])
    e += bytes(3) + b"\x01\x01" * 8
    e += bytes([0x02, 0x3A, 0x80, 0x18, 0x71, 0x38, 0x2D, 0x40, 0x58, 0x2C,
                0x45, 0x00, 0x08, 0x22, 0x21, 0x00, 0x00, 0x1E])
    e += descriptor(0xFF, SERIAL_TEXT) + descriptor(0xFE, ASSET_TAG) + descriptor(0xFC, NAME)
    e += bytes([0])
    e += bytes([(256 - sum(e) % 256) % 256])
    assert len(e) == 128
    return bytes(e)


def edid_command():
    path = os.path.join(os.environ["FPP_TREE"], "www", "troubleshoot-commands.json")
    with open(path) as f:
        groups = json.load(f)["CommandGroups"]
    for group in groups.values():
        if "displayEDID" in group.get("commands", {}):
            return group["commands"]["displayEDID"]
    pytest.fail("troubleshoot-commands.json has no displayEDID command")


def run(cmd, sysfs):
    assert "'" not in cmd, "the command runs inside sh -c '...'"
    assert SYSFS in cmd, "the command no longer reads the connectors from sysfs"
    r = subprocess.run(["/bin/sh", "-c", cmd.replace(SYSFS, sysfs + "/card*-*/")],
                       capture_output=True, text=True, timeout=20)
    return r.stdout + r.stderr


def test_a_diagnostic_report_gets_the_edid_without_the_displays_unique_ids(tmp_path):
    if not shutil.which("edid-decode"):
        pytest.skip("edid-decode is not installed")
    conn = tmp_path / "card0-HDMI-A-1"
    conn.mkdir()
    (conn / "status").write_text("connected\n")
    (conn / "edid").write_bytes(make_edid())
    (tmp_path / "card0-HDMI-A-2").mkdir()
    (tmp_path / "card0-HDMI-A-2" / "status").write_text("disconnected\n")

    command = edid_command()
    assert command.get("pii") is True, "the full EDID identifies the display, so the command is pii"
    assert command.get("manualCrashReportCmd"), "without one, Diagnostic Reports leave the EDID out"

    # The page's full output: proves the made-up EDID carries every ID.
    page = run(command["cmd"], str(tmp_path))
    for text in (SERIAL_TEXT, ASSET_TAG, str(SERIAL), "2019", NAME, "=== card0-HDMI-A-1 ==="):
        assert text in page, f"{text!r} missing from the page's output:\n{page}"
    assert "HDMI-A-2" not in page, "a disconnected connector was decoded"

    report = run(command["manualCrashReportCmd"], str(tmp_path))
    for text in (SERIAL_TEXT, ASSET_TAG, str(SERIAL), f"{SERIAL:08x}", "2019"):
        assert text.lower() not in report.lower(), f"{text!r} reached the report:\n{report}"
    assert "hex" not in report.split("\n", 2)[1].lower(), f"the hex dump reached the report:\n{report}"
    # Still useful: which display, and what it can do.
    for text in (NAME, "1920x1080", "52 cm x 29 cm"):
        assert text in report, f"{text!r} missing from the report:\n{report}"
