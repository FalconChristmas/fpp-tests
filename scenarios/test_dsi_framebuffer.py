"""Framebuffer models on a DSI touchscreen (the official 7" display, say).

Runs anywhere, Docker included. The DSI panel is the fake card of fakedrm.c
with a DSI-1 connector (see fakedrm.py) for the KMS path; with no DRM card,
fakefb.c's /dev/fb0 stands in for the fbdev console a DSI panel gets.
"""

import re
import time

import fakedrm
from framebuffer import FakeFb


def fb_model(fppd, device, width, height):
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Panel", "Type": "FB", "Width": width, "Height": height, "Device": device}]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="debug")


def test_a_small_model_on_a_dsi_panel_goes_through_kms(fppd):
    """A 64x32 FB model on DSI-1: it is driven through KMS, which scales it
    up onto the 800x480 panel's plane and page-flips it, not through fbdev.

    Regression: 810b6dbb3 (#2713). A model under 1280x720 was sent to the
    IOCTL fbdev path whatever the device, and fbdev can neither present a
    buffer smaller than the panel's mode nor scan out reliably on vc4:
    images on a DSI screen never showed.
    """
    fb_model(fppd, "DSI-1", 64, 32)
    preload, env = fakedrm.dsi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: any(m.get("Name") == "Panel" for m in fppd.get("/overlays/models")),
                  timeout=15, what="the FB model on DSI-1")
    fppd.command("Overlay Model Fill", "Panel", "Enabled", "#FF0000")
    time.sleep(1)
    assert "KMSFrameBuffer: DSI-1 mode 800x480" in fppd.log(), fppd.tail()
    # 64x32 at 12x is 768x384, scaled onto the whole 800x480 panel.
    assert re.search(r"^plane \d+ \w+ 800x480\+0\+0 src 768x384", fakedrm.log(fppd), re.M), \
        fakedrm.log(fppd)[-2000:]


def test_a_dsi_model_without_kms_draws_on_the_console_framebuffer(fppd):
    """No DSI-1 on any DRM card (no card at all in a container), only the
    console's /dev/fb0: an FB model on DSI-1 falls back to fbdev, which
    maps the connector name to fb0 and opens it.

    Regression: 05d9dfa91. The fbdev path mapped HDMI, DPI and DisplayPort
    connector names to fb0 but not DSI, and opened a /dev/DSI-1 that never
    exists: the model was never created.
    """
    fb = FakeFb(fppd, name="fb0", width=800, height=480, bpp=32, pages=2)
    fb_model(fppd, "DSI-1", 800, 480)
    fb.start()
    fppd.wait_for(lambda: fb.mode() is not None, timeout=15, what="fbdev to open fb0 for DSI-1")
    assert "Mapping DRM connector 'DSI-1' to 'fb0'" in fppd.log(), fppd.tail()
