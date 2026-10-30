"""The serial number the About page shows, and that EEPROM signing sends,
on a PocketBeagle2: it has no Serial line in /proc/cpuinfo, so both read
the board's own identity EEPROM (0-0050, the 16 bytes from offset 40).

Each block is the tree's own PHP, run with php-cli with $settings as
config.php sets them on the board (SubPlatform: the device tree model),
and it reads the real EEPROM -- read only. Device only: run-local.sh on a
PocketBeagle2 with php-cli. Skipped elsewhere.
"""

import os
import shutil
import subprocess

import pytest

ID_EEPROM = "/sys/bus/i2c/devices/0-0050/eeprom"


def model():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().strip("\0\n ")
    except OSError:
        return ""


pytestmark = pytest.mark.skipif("PocketBeagle2" not in model(), reason="needs a PocketBeagle2")


def board_serial():
    try:
        with open(ID_EEPROM, "rb") as f:
            f.seek(40)
            return f.read(16).decode(errors="replace")
    except OSError as e:
        pytest.skip(f"no identity EEPROM to read: {e}")


def serial_from(tmp_path, page, start, end):
    """$serialNumber after the block of the tree's `page` from `start` up to
    `end`."""
    php = shutil.which("php")
    if not php:
        pytest.skip("no php-cli here")
    with open(os.path.join(os.environ["FPP_TREE"], "www", page)) as f:
        src = f.read()
    i = src.find(start)
    j = src.find(end, i)
    assert i >= 0 and j > i, f"{page} has no serial number block"
    script = tmp_path / "serial.php"
    script.write_text("<?php\n$settings = array('SubPlatform' => " + repr(model()).replace('"', "'") + ");\n"
                      + src[i:j] + "\necho isset($serialNumber) ? $serialNumber : '';\n")
    r = subprocess.run([php, str(script)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


@pytest.mark.parametrize("page,start,end", [
    ("about.php", 'if (file_exists("/proc/cpuinfo")) {', "unset($output);"),
    ("api/controllers/cape.php", '$serialNumber = "";', "$data = array();"),
], ids=["about", "signing"])
def test_a_pocketbeagle2_reports_the_serial_in_its_identity_eeprom(tmp_path, page, start, end):
    """Feature: 2f0ae5488 (PB2 serial numbers). Before it the About page
    showed none and the signing request went with an empty serial."""
    want = board_serial()
    assert want.strip("\0\xff "), f"the identity EEPROM holds no serial: {want!r}"
    assert serial_from(tmp_path, page, start, end) == want
