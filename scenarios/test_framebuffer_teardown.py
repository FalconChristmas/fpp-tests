"""What a framebuffer output leaves behind when it goes away: a channel-output
reload deletes the old one, and everything it took from the display has to
come back.

Runs anywhere, Docker included: the display is the fake Pi 3 card of
fakedrm.c (see fakedrm.py).
"""

import os
import time

import fakedrm
import shims

W, H = 64, 32


def matrix(fppd, width=W):
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": width * H * 3,
         "device": fakedrm.CONNECTOR, "width": width, "height": H}]})


def buffers(path):
    """(created, destroyed) dumb buffer handles, in order."""
    created, destroyed = [], []
    try:
        with open(path) as f:
            for line in f:
                what, handle = line.split()
                (created if what == "create" else destroyed).append(int(handle))
    except FileNotFoundError:
        pass
    return created, destroyed


def test_a_reloaded_virtual_matrix_gives_back_its_display_buffers(fppd):
    """A Virtual Matrix on HDMI, drawing under test mode, is replaced by a
    channel-output save: every dumb buffer the first one created on the card
    is destroyed, and the second one comes up on the same connector.

    Regression: 4fe5b78df. ~FrameBuffer() called the virtual
    DestroyFrameBuffer(), which from a base destructor only reaches
    FrameBuffer's own, so KMSFrameBuffer::DestroyFrameBuffer() never ran on
    delete: each reload left the old pages mapped and their dumb buffers
    (CMA on a Pi) allocated, and the plane/CRTC/connector reserved. The
    other half of the fix -- the draw loop stopped before any subclass
    teardown, instead of joined in ~FrameBuffer() -- has no outcome here
    that can be told apart."""
    matrix(fppd)
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
    log = os.path.join(fppd.media, "tmp", "dumbbufs.log")
    preload, env = fakedrm.start_env(fppd)
    env["DUMBBUFS_LOG"] = log
    so = shims.build("dumbbufs.c", libs=("-ldl", "-lpthread", "-I/usr/include/libdrm"))
    fppd.start(preload=[so] + preload, extra_env=env)
    mode_line = f"KMSFrameBuffer: {fakedrm.CONNECTOR} mode"
    fppd.wait_for(lambda: mode_line in fppd.log(), timeout=15, what="the Virtual Matrix on the fake display")
    fppd.command("Test Start", 1000, "RGB Cycle", f"1-{W * H * 3}", "R-G-B")
    time.sleep(1)
    first, _ = buffers(log)
    assert first, "the first matrix created no dumb buffers"

    # The save: a matrix of another width, so the reload builds a new one.
    matrix(fppd, width=W * 2)
    fppd.wait_for(lambda: fppd.log().count(mode_line) >= 2, timeout=15,
                  what="the reloaded Virtual Matrix on the fake display")
    fppd.command("Test Stop")
    created, destroyed = buffers(log)
    assert len(created) > len(first), created
    leaked = [h for h in first if h not in destroyed]
    assert not leaked, (f"dumb buffers {leaked} of the first matrix were never destroyed "
                        f"(created {created}, destroyed {destroyed})")
