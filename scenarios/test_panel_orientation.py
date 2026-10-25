"""A panel matrix's per-panel orientation, read from its config.

Runs anywhere X11PanelMatrix is built (Docker: on fakex11.c's stand-in for
an X server); the same reading is in RGBMatrix, BBBMatrix and BBShiftPanel.
"""

import os

import pytest

import shims


def x11_frame(path):
    """The last image the X11 output put (fakex11.c), as rows of (r, g, b),
    or None before the first."""
    try:
        with open(path, "rb") as f:
            head = f.readline().split()
            data = f.read()
    except FileNotFoundError:
        return None
    w, h = int(head[0]), int(head[1])
    return [[(data[(y * w + x) * 4 + 2], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4])
             for x in range(w)] for y in range(h)]


def test_an_upside_down_panel_is_drawn_upside_down(fppd):
    """One 32x16 X11 panel configured with orientation "U": the matrix's
    first pixel (channels 1-3) is drawn at the panel's far corner.

    Regression: fb7562a34. The panel loop kept asString().c_str() of the
    orientation past the end of the statement and then read the letter
    through it: a pointer into the destroyed temporary (an ASan
    stack-use-after-scope in Init()).
    """
    if not os.path.exists(os.path.join(fppd.tree, "src", "libfpp-co-matrix-X11PanelMatrix.so")):
        pytest.skip("no X11PanelMatrix output in this build (no X11 headers)")
    pw, ph = 32, 16
    fppd.write("config/channeloutputs.json", {"channelOutputs": [{
        "type": "LEDPanelMatrix", "subType": "X11PanelMatrix", "enabled": 1,
        "startChannel": 1, "channelCount": pw * ph * 3, "panelWidth": pw, "panelHeight": ph,
        "colorOrder": "RGB", "invertedData": 0, "scale": 1, "title": "fpp-tests",
        "panels": [{"outputNumber": 0, "panelNumber": 0, "colorOrder": "", "xOffset": 0,
                    "yOffset": 0, "orientation": "U"}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    frame_file = os.path.join(fppd.media, "tmp", "x11-frame")
    fppd.start(preload=[shims.build("fakex11.c")], extra_env={"FAKEX11_FILE": frame_file})
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 255})

    def lit():
        frame = x11_frame(frame_file)
        if frame is None:
            return None
        return sorted((x, y) for y, row in enumerate(frame) for x, p in enumerate(row) if p != (0, 0, 0))
    fppd.wait_for(lambda: lit() == [(pw - 1, ph - 1)], timeout=10,
                  what=f"the far corner lit (last: {lit()})")
