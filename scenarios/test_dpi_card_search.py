"""Where DPIPixels looks for the DPI display connector.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built only
there). fakedrm.so stands in for the display card with a DPI-1 connector
running the mode FPP's DPI overlay sets up, as in test_dpi_refresh.py.
"""

import os

import pytest

import fakedrm
import shims
from test_dpi_pixels import on_pi
from test_dpi_refresh import setup

pytestmark = pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")


def test_the_dpi_connector_is_found_on_a_third_card(fppd):
    """A DPI-1 connector whose sysfs node is card2-DPI-1, as on a Pi 5,
    where card0 is the 3D engine, card1 the HDMI controller and the RP1
    DPI a card of its own: DPIPixels finds it and comes up on the DPI
    panel, without falling back to an fbdev framebuffer.

    Regression: ecd5d1d48. Only card0-DPI-1 and card1-DPI-1 were looked
    for, so with the DPI on card2 the output fell back to /dev/fb1 and
    failed to open it ("cannot open FrameBuffer device for fb1"; shown on a
    Pi 5 with the card search reverted on master).

    The fake card's device node is /dev/dri/card0 whatever its sysfs node
    is called: KMS finds the DPI-1 connector by scanning the cards, and
    only DPIPixels' lookup reads the sysfs name.
    """
    setup(fppd)
    preload, env = fakedrm.dpi_env(fppd)
    drm = os.path.join(env["FAKEDRM_DIR"], "sys", "class", "drm")
    os.rename(os.path.join(drm, "card0-DPI-1"), os.path.join(drm, "card2-DPI-1"))
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log()
                  or "cannot open FrameBuffer" in fppd.log(), timeout=15,
                  what="DPIPixels to open a framebuffer")
    assert "DPIPixels: framebuffer 1920x" in fppd.log(), fppd.tail()
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not [w for w in warnings if "FrameBuffer" in w], warnings


def test_a_framebuffer_that_cannot_be_opened_is_warning_13(fppd):
    """With no DPI connector to be found, DPIPixels falls back to an fbdev
    framebuffer (fb1); when that cannot be opened it says so in a warning
    with id 13 -- the one whose help page (warning-13.md) says to check the
    DPI overlay in config.txt and reboot.

    Regression: e062aa1da ("improve warning messages"). That warning had no
    id, so the UI had no help page to link it to.

    fakesys.c hides the box's own /dev/fb0 and /dev/fb1 from fppd (this one
    has an HDMI fb0, which would open and fail later, as not set up for DPI).
    """
    setup(fppd)
    preload, env = fakedrm.dpi_env(fppd)
    drm = os.path.join(env["FAKEDRM_DIR"], "sys", "class", "drm")
    os.rename(os.path.join(drm, "card0-DPI-1"), os.path.join(drm, "card0-HDMI-A-9"))
    gone = os.path.join(fppd.media, "tmp", "no-such-dev")
    env["FAKESYS"] = f"/dev/fb0={gone}/fb0:/dev/fb1={gone}/fb1"
    fppd.start(preload=[*preload, shims.build("fakesys.c")], extra_env=env)

    def info():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                if "Could not open FrameBuffer device for fb1" in w.get("message", "")]
    fppd.wait_for(info, timeout=15, what="the FrameBuffer warning")
    assert [w.get("id") for w in info()] == [13], info()
