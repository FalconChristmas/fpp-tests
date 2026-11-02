"""The Raspberry Pi under-voltage warning, from the firmware's get_throttled
word (/dev/vcio), answered by fakevcio.c.

Device only: run-local.sh on a Pi (the check is compiled for the Pi platform).
"""

import os
import time

import pytest

import shims
from test_dpi_pixels import on_pi

pytestmark = pytest.mark.skipif(not on_pi(), reason="the power check is built for a Raspberry Pi")

WARNING = "Raspberry Pi Voltage Too Low"


def warned(fppd):
    return any(WARNING in str(w) for w in fppd.get("/fppd/warnings"))


def supply(fppd, word):
    fppd.write("tmp/throttled", word + "\n")


def test_the_voltage_warning_waits_for_repeated_bad_readings_and_goes_when_they_stop(fppd):
    """An under-voltage reading marks powerBad at once, but the banner
    "Raspberry Pi Voltage Too Low" only goes up after more than five bad
    readings in a row, and comes down after more than five good ones. The
    reading comes from the get_throttled mailbox word on /dev/vcio.

    Regression: afebeef13 (and c30f26f79, which moved the power-bad test from
    the PWR led to this word). The banner went up on the first bad reading, so a
    single dip at power-up left it on screen; (comes down: a later change.)
    """
    supply(fppd, "0x1")
    fppd.start(preload=[shims.build("fakevcio.c")],
               extra_env={"FAKEVCIO_FILE": os.path.join(fppd.media, "tmp", "throttled")})
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("powerBad") is True, timeout=15,
                  what="powerBad from the first bad reading")
    assert not warned(fppd), "the banner went up on the first bad reading"
    fppd.wait_for(lambda: warned(fppd), timeout=30, what="the warning after repeated bad readings")
    supply(fppd, "0x0")
    fppd.wait_for(lambda: not warned(fppd), timeout=40, what="the warning to come down after good readings")
    assert fppd.get("/fppd/status").get("powerBad") is False
