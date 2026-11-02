"""A Virtual Matrix whose saved channel count is not its size: the count
the output page saved was right when the model was a different size."""

import time

from framebuffer import FakeFb
from test_display_outputs import W, H, virtual_matrix


def test_a_virtual_matrix_takes_its_channel_count_from_its_model(fppd):
    """A Virtual Matrix saved with a channel count that no longer matches
    the size of its model (here 100, for a 64x32 one) still draws, and
    its channels are the model's: width x height x 3.

    Regression: fc11872d4. The output took the saved count and compared
    it with the model's size, so one that had changed since the page
    saved it was refused as an invalid Pixel Overlay Model and nothing
    was drawn.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    out = virtual_matrix(W, H)
    out["channelCount"] = 100
    fppd.write("config/co-other.json", {"channelOutputs": [out]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 1000, "RGB Single Color", "1-3", "#FF8001")

    def lit():
        if fb.mode() is None:
            return []
        return [(x, y) for y, row in enumerate(fb.pixels()) for x, p in enumerate(row) if p != (0, 0, 0)]
    fppd.wait_for(lit, timeout=10, what="the matrix's first pixel on the device")
    time.sleep(0.5)
    assert fb.pixels()[0][0] == (255, 128, 1)
    assert "Invalid Pixel Overlay Model" not in fppd.log()
