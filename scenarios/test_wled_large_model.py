"""WLED effects on a model bigger than WLED's stock 8192 pixel limit."""

import time

from ddp import DdpReceiver
from test_overlay_geometry import LIT, PRIMER, lit_nodes, percent
from test_overlays import fill, matrix, setup

WIDTH, HEIGHT = 128, 80  # 10240 nodes, over the stock limit of 8192


def test_a_wled_effect_covers_a_model_of_over_8192_pixels(fppd):
    """WLED - Percent at 50% on a 128 x 80 model (10240 pixels) lights the
    first 5120 nodes in its colour and no others.

    Regression: c96a73bd1. WLED's stock limit of 8192 rendered pixels
    refused a bigger matrix ("2D Bounds error") and the effect drew
    nothing on the model; fpp raises the limit to 64K.
    """
    nodes = WIDTH * HEIGHT
    setup(fppd, [matrix("M", width=WIDTH, height=HEIGHT)], channels=nodes * 3)
    seen = {}

    def lit():
        f = rx.last()
        if f is None:
            return False
        got = lit_nodes(f, nodes)
        seen["n"] = len(got)
        seen["span"] = (min(got), max(got)) if got else None
        seen["colours"] = sorted(set(got.values()))[:3]
        return got == {n: LIT for n in range(nodes // 2)}

    with DdpReceiver(nodes * 3) as rx:
        fppd.start()
        fill(fppd, "M", PRIMER)
        fppd.wait_for(lambda: rx.last() is not None and len(lit_nodes(rx.last(), nodes)) == nodes,
                      timeout=15, what="the model primed")
        percent(fppd, "M", "Horizontal", 50)
        deadline = time.monotonic() + 15
        while not lit() and time.monotonic() < deadline:
            fppd.check_alive()
            time.sleep(0.1)
        assert lit(), (f"{seen['n']} nodes lit (want {nodes // 2}), spanning {seen['span']}, "
                       f"colours {seen['colours']}")
