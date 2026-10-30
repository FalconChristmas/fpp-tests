"""BBShiftPanel on one PRU (a panel cape whose config says "singlePRU"), on
the real PRUs of a PocketBeagle2 under run-local.sh --host-pru (see pru.py).
Panel configs come only from the cape's EEPROM, so the scenario stands in a
cape of its own: an unsigned EEPROM image in run-local.sh's /home/fpp/media
overlay carrying the PocketScroller v3 panel config (8 of its outputs) with
"singlePRU" set (unsigned, the cape licenses output 1 only: the matrix uses
that one). It is put back after.

The panel program drives the PRU's own output pins (r30), read here by
halting PRU1 now and then and reading r30 from its debug registers.

Device only: run with run-local.sh --host-pru on a PocketBeagle2 with the
device's own fppd stopped. Skipped elsewhere.
"""

import os
import shutil
import time

import pytest

import cape_eeprom as ee
import pru
from pru import real_pru  # noqa: F401 (a fixture)
from test_am62x_panels import matrix, panels_config

VIRTUAL_EEPROM = "/home/fpp/media/config/cape-eeprom.bin"
OE_BIT = 9  # OE_PIN in BBShiftPanel.asm

# the PocketScroller v3 cape's panel config, as its EEPROM carries it, cut to
# the first shift stage of each data pin: 8 outputs, so the 8-output program
# (BBShiftPanel_single.out, not _single_16.out)
POCKETSCROLLER = {
    "name": "PocketScroller", "longName": "PocketScroller", "driver": "BBShiftPanel", "pru": 1,
    "defaults": {"LEDPanelsWiringPinout": "PocketScroller3x", "LEDPanelsConnection": "LEDscapeMatrix"},
    "controls": {
        "latch": {"pin": "P1-29", "type": "pruout"}, "oe": {"pin": "P1-36", "type": "pruout"},
        "clock": {"pin": "P1-33", "type": "pruout"}, "sel0": {"pin": "P2-32", "type": "pruout"},
        "sel1": {"pin": "P2-30", "type": "pruout"}, "sel2": {"pin": "P1-31", "type": "pruout"},
        "sel3": {"pin": "P2-34", "type": "pruout"}, "sel4": {"pin": "P2-28", "type": "pruout"},
        "olatch": {"pin": "P2-18", "type": "pruout"}, "oclock": {"pin": "P2-35", "type": "pruout"},
        "oclr": {"pin": "P2-22", "type": "pruout"}},
    "outputs": [{"pin": p, "index": 0}
                for p in ("P2-33", "P1-20", "P2-08", "P2-04", "P2-24", "P2-20", "P2-06", "P2-02")],
}


@pytest.fixture
def single_pru_panel_cape():
    if not os.path.isdir(os.path.dirname(VIRTUAL_EEPROM)):
        pytest.skip("no /home/fpp/media here")
    saved = VIRTUAL_EEPROM + ".fpp-tests"
    had = os.path.exists(VIRTUAL_EEPROM)
    if had:
        shutil.copyfile(VIRTUAL_EEPROM, saved)
    cfg = dict(POCKETSCROLLER, singlePRU=True)
    with open(VIRTUAL_EEPROM, "wb") as f:
        f.write(ee.image(ee.cape_info(), files={"panels/PocketScroller.json": cfg}))
    try:
        yield
    finally:
        if had:
            os.replace(saved, VIRTUAL_EEPROM)
        else:
            os.remove(VIRTUAL_EEPROM)


def test_a_single_pru_panel_program_drives_its_own_oe_line(real_pru, single_pru_panel_cape, fppd):
    """A one-PRU panel cape: PRU1 runs BBShiftPanel_single.out, and that
    program switches the display on and off itself -- its OE output (r30
    bit 9, high is off) is seen low at times while a test pattern runs.

    Regression: 0871c136b. The makefile built BBShiftPanel_single.out
    without -DSINGLEPRU (and the two-PRU image with it): the one-PRU
    program left OE to an OE program on the other core that a single-PRU
    cape never starts, so OE stayed high and the panels stayed dark.
    (Its Sensors.cpp half drops two debug printf()s.)
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(brightness=100)))
    fppd.start(timeout=90)
    if "Could not read panel pin configuration" in fppd.log():
        pytest.skip("the stand-in cape's panel config was not read")
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(4)
    with open("/lib/firmware/am62x-pru1-fw.fpp", "rb") as f:
        running = f.read()
    with open("/opt/fpp/src/non-gpl/BBShiftPanel/BBShiftPanel_single.out", "rb") as f:
        assert running == f.read(), "PRU1 is not running the single-PRU panel program"
    seen = []
    with pru.Pruss() as p:
        for _ in range(400):
            assert p.halt(1), "PRU1 did not halt"
            seen.append((p.register(1, 30) >> OE_BIT) & 1)
            assert p.resume(1), "PRU1 did not stay running"
            time.sleep(0.002)
    fppd.command("Test Stop")
    assert 0 in seen, f"OE never went low in {len(seen)} samples of r30"
