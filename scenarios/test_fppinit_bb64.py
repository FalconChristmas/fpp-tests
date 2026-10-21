"""fppinit steps that only a BeagleBone 64 build has (PLATFORM_BB64), in the
fppinit sandbox. Device only: run with run-local.sh on a PocketBeagle2.
"""

import os
import time

import pytest

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture


def on_pb2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pb2(), reason="a PocketBeagle2 build of fppinit")

REPAIRING = "PocketBeagle2 EEPROM identity is blank or malformed, repairing"


def identity(valid=True):
    """The first 56 bytes the check reads: the 0xAA55 magic, then the unit
    number's six ASCII digits at 50..55."""
    if not valid:
        return b"\xff" * 256
    return b"\xaa\x55" + b"\0" * 48 + b"000123" + b"\0" * 200


def configure(sb, monkeypatch, eeprom):
    """Run `fppinit configureBBB` with the identity EEPROM at a fixture in
    the sandbox's media directory (fppinit and the repair script it forks
    both take PB2_EEPROM)."""
    if eeprom is not None:
        sb.write_bytes("pb2-eeprom.bin", eeprom)
    monkeypatch.setenv("PB2_EEPROM", f"{MEDIA}/pb2-eeprom.bin")
    # the repair script's other probes, pointed at nothing, so it doesn't wait
    # on the real eMMC and i2c devices
    for k in ("PB2_EMMC_TYPE", "PB2_I2CDEV", "PB2_ADCDEV"):
        monkeypatch.setenv(k, f"{MEDIA}/absent")
    t = time.monotonic()
    r = sb.run("configureBBB")
    return r.stdout + r.stderr, time.monotonic() - t


def test_a_healthy_identity_eeprom_is_left_alone_quickly(fppinit, monkeypatch):
    """A PocketBeagle2 whose identity EEPROM is valid is checked at boot and
    left alone: no repair, and well under the repair script's ~10 s.

    Feature: 734688559. Before it the identity was only checked when the
    board was flashed.
    """
    out, took = configure(fppinit, monkeypatch, identity(valid=True))
    assert REPAIRING not in out, out[-3000:]
    assert took < 10, f"configureBBB took {took:.1f}s"


def test_a_blank_identity_eeprom_is_repaired_at_boot(fppinit, monkeypatch):
    """A blank identity EEPROM is noticed at boot and the repair script is
    run for it.

    Feature: 734688559. Before it a board that reached FPP other than by
    flashing kept a blank identity (u-boot sizing it as the base board) for
    good.
    """
    out, _ = configure(fppinit, monkeypatch, identity(valid=False))
    assert REPAIRING in out, out[-3000:]
    assert "EEPROM" in out.split(REPAIRING, 1)[1], f"the repair script said nothing:\n{out[-3000:]}"


def test_no_identity_eeprom_is_reported_without_waiting(fppinit, monkeypatch):
    """With no EEPROM at 0x50 there is nothing to repair: fppinit says so and
    goes on without the repair script's diagnostic wait.

    Feature: 734688559.
    """
    out, took = configure(fppinit, monkeypatch, None)
    assert "no EEPROM at" in out and "board identity unavailable" in out, out[-3000:]
    assert REPAIRING not in out, out[-3000:]
    assert took < 10, f"configureBBB took {took:.1f}s"
