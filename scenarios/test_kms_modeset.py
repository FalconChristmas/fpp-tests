"""Bringing up a display whose CRTC is off, from a KMS framebuffer output.

Runs anywhere, Docker included: the display is the fake Pi 3 card of
fakedrm.c (see fakedrm.py), which refuses a legacy modeset whose
framebuffer is smaller than the mode, as the kernel does, and logs every
CRTC and plane change.
"""

import re
import time

import fakedrm


def test_a_matrix_smaller_than_the_panel_lights_a_crtc_that_was_off(fppd):
    """A 100x100 Virtual Matrix on an HDMI display whose CRTC is off (no
    console left it running): its picture is 1000x1000 at 10x, short of the
    1920x1080 mode, and the output still turns the CRTC on and shows it on
    its plane.

    Also 936ad3e30: the KMS framebuffer output itself (it split FrameBuffer
    into the ioctl, KMS and socket classes); with KMS not offered the
    output never comes up on the fake display.
    Regression: 9cc9195f4 (its modeset half; test_kms_hotplug.py has the
    hotplug half). Legacy SetCrtc scans the primary plane out at
    the full mode size, so a modeset with the model's framebuffer always
    failed (ENOSPC); it only ever seemed to work because the console had
    left the CRTC running. With the CRTC off, it stayed off and every flip
    was rejected. ModesetLocked() lights it with a blank mode-sized buffer
    and puts the picture on the plane.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": 100 * 100 * 3,
         "device": fakedrm.CONNECTOR, "width": 100, "height": 100}]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
    preload, env = fakedrm.start_env(fppd, crtc_off=True)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: f"KMSFrameBuffer: {fakedrm.CONNECTOR} mode" in fppd.log(), timeout=15,
                  what="the Virtual Matrix on the fake display")
    fppd.command("Test Start", 1000, "RGB Cycle", f"1-{100 * 100 * 3}", "R-G-B")
    time.sleep(3)
    fppd.command("Test Stop")
    card = fakedrm.log(fppd)
    assert re.search(r"^crtc 1920x1080@60 ", card, re.M), \
        f"the CRTC was never turned on\n--- fake card:\n{card[-2000:]}\n{fppd.tail()}"
    assert re.search(r"^plane \d+ \w+ 1920x1080\+0\+0 src 1000x1000", card, re.M), \
        f"the matrix never reached its plane\n--- fake card:\n{card[-2000:]}"
