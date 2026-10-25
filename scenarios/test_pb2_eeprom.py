"""The PocketBeagle 2 identity EEPROM checks and repairs that run before an
image is flashed to eMMC (capes/drivers/bb64): check_pb2_eeprom.sh, and the
fix_pb2*_eeprom.sh merges it calls.

The scripts take their sysfs paths from the environment (PB2_EEPROM,
PB2_EMMC_TYPE, PB2_I2CDEV, PB2_ADCDEV, PB2_MODEL), so each scenario hands
them fixtures shaped like the board's sysfs: an EEPROM file of the
emulated 24c32's 4 KB, the eMMC's device type, the i2c client directories.
No fppd; runs anywhere bash, xxd and python3 are (Docker, a device).
"""

import os
import re
import shutil
import subprocess

import pytest

BB64 = os.path.join(os.environ.get("FPP_TREE", "/opt/fpp"), "capes", "drivers", "bb64")

# A factory-programmed industrial board's first 64 bytes, as fix_pb2i_eeprom.sh
# carries them, with its unit number (50..55) "005692".
PB2I = bytes.fromhex(
    "aa5533ee013700102e00504f434b4554"
    "424541474c3241314930413130303030"
    "49304130413130303031303432365042"
    "3249303035363932110200a812feffff")


def board(tmp_path, eeprom=None, emmc=True, i2c=True, adc=True):
    """Fixtures for one board: returns the scripts' environment."""
    env = dict(os.environ, LC_ALL="C")
    model = tmp_path / "model"
    model.write_bytes(b"BeagleBoard.org PocketBeagle2\0")
    env["PB2_MODEL"] = str(model)
    dev = tmp_path / "0-0050"
    if i2c:
        dev.mkdir()
    env["PB2_I2CDEV"] = str(dev)
    env["PB2_EEPROM"] = str(dev / "eeprom")
    if eeprom is not None:
        (dev / "eeprom").write_bytes(eeprom)
    adcdev = tmp_path / "0-0020"
    adcdev.mkdir()
    if adc:
        (adcdev / "driver").mkdir()
    env["PB2_ADCDEV"] = str(adcdev)
    emmc_type = tmp_path / "mmcblk0-type"
    if emmc:
        emmc_type.write_text("MMC\n")
    env["PB2_EMMC_TYPE"] = str(emmc_type)
    return env


def blank(n=4096):
    return b"\xff" * n


def run(script, env, *args):
    if not shutil.which("xxd"):
        pytest.skip("needs xxd")
    path = os.path.join(BB64, script)
    if not os.path.exists(path):
        pytest.fail(f"{script} is not in the tree")
    with open(path) as f:
        if "PB2_EEPROM" not in f.read():
            # it would write the real /sys/bus/i2c/devices/0-0050/eeprom
            pytest.fail(f"{script} takes no fixture EEPROM (PB2_EEPROM); not run")
    return subprocess.run(["bash", path, *args], env=env, capture_output=True, text=True, timeout=120)


def unit(data):
    return data[50:56].decode("ascii", "replace")


def test_a_blank_industrial_eeprom_gets_the_industrial_identity(tmp_path):
    """fix_pb2i_eeprom.sh on an EEPROM that was never programmed writes the
    industrial board's identity -- the AA55 header, board ID PB2I -- with a
    unit number of its own (six digits, the lead one 2-9, which the factory
    never issues).

    Regression: a711a2cad. There was only the base board's fix script, so
    an industrial board with a blank EEPROM could only be stamped as a
    PB20, which u-boot then brings up on half its RAM.
    """
    env = board(tmp_path, blank())
    r = run("fix_pb2i_eeprom.sh", env)
    assert r.returncode == 0, r.stderr
    data = (tmp_path / "0-0050" / "eeprom").read_bytes()
    assert data[:2] == b"\xaa\x55" and data[46:50] == b"PB2I", data[:64].hex(" ")
    assert re.fullmatch(r"[2-9][0-9]{5}", unit(data)), unit(data)


def test_a_partly_programmed_industrial_eeprom_is_repaired_before_flashing(tmp_path):
    """An industrial board (eMMC fitted) whose EEPROM has its header and
    board ID but a blank unit number: check_pb2_eeprom.sh repairs it with
    the industrial template, re-reads it, and passes the board.

    Regression: 5dea38b2f. The flasher's bb64 preflight checked nothing,
    so such a board was flashed as it was.
    """
    ee = bytearray(blank())
    ee[:64] = PB2I
    ee[50:56] = b"\xff" * 6
    env = board(tmp_path, bytes(ee))
    r = run("check_pb2_eeprom.sh", env)
    assert r.returncode == 0, r.stdout + r.stderr
    data = (tmp_path / "0-0050" / "eeprom").read_bytes()
    assert data[46:50] == b"PB2I" and re.fullmatch(r"[0-9]{6}", unit(data)), data[:64].hex(" ")
    assert "repaired and verified" in r.stdout, r.stdout


@pytest.mark.parametrize("adc", [True, False], ids=["mspm0-running", "mspm0-silent"])
def test_an_eeprom_that_is_not_there_stops_the_flash(tmp_path, adc):
    """The i2c client at 0x50 exists but nothing bound to it (the MSPM0
    that emulates the EEPROM is not serving it): the check fails the flash,
    saying whether the MSPM0 is running (its emulated ADC bound) or not.

    Regression: 5dea38b2f. An EEPROM that could not be repaired was warned
    about and the flash carried on.
    """
    env = board(tmp_path, eeprom=None, adc=adc)
    r = run("check_pb2_eeprom.sh", env)
    assert r.returncode == 1, r.stdout + r.stderr
    want = "is not serving 0x50" if adc else "MSPM0 itself is not running"
    assert want in r.stderr, r.stderr


def test_a_base_board_id_on_a_board_with_emmc_stops_the_flash(tmp_path):
    """A fully programmed EEPROM that says PB20 (base board) on hardware
    with eMMC, which only the industrial has: the merge-based fix cannot
    rewrite programmed bytes, so the check refuses rather than run it.

    Regression: 5dea38b2f.
    """
    ee = bytearray(blank())
    ee[:64] = PB2I
    ee[46:50] = b"PB20"
    env = board(tmp_path, bytes(ee))
    r = run("check_pb2_eeprom.sh", env)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "board ID reads PB20" in r.stderr, r.stderr


def test_an_eeprom_that_reads_short_is_not_taken_for_a_blank_one(tmp_path):
    """An EEPROM file that returns nothing (a read failing with EIO looks
    like this): the check fails on the short read instead of treating the
    empty header as blank and trying to repair it.

    Regression: 5dea38b2f.
    """
    env = board(tmp_path, eeprom=b"")
    r = run("check_pb2_eeprom.sh", env)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "64-byte read returned 0 bytes" in r.stderr, r.stderr
