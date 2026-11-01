"""A rectangle submodel draws into its parent at its own offset."""

from ddp import DdpReceiver
from test_overlays import CHANNELS, WIDTH, fill, keeps_sending, matrix, setup, submodel, wait_output


def test_a_submodel_fills_its_own_rectangle_of_the_parent(fppd):
    """Filling a 4x2 submodel at (3, 2) of a 10x5 parent lights exactly those
    eight nodes of the parent, and nothing else.

    Feature: 4d72606a7 (the Sub-Model type).

    Also 3702f53af: a submodel's pixels reach its parent's channels through
    the parent's child list when the parent itself is disabled."""
    x0, y0, w, h = 3, 2, 4, 2
    setup(fppd, [matrix(), submodel("Corner", "M", x0, y0, w, h)])
    colour = bytes([200, 100, 50])
    want = bytearray(CHANNELS)
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            want[(y * WIDTH + x) * 3:(y * WIDTH + x) * 3 + 3] = colour
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "Corner", list(colour))
        wait_output(fppd, rx, lambda f: any(f), "the submodel to reach the wire")
        keeps_sending(rx)
        frame = rx.last()
        assert frame == bytes(want), \
            f"lit nodes (x, y): {[(i // 3 % WIDTH, i // 3 // WIDTH) for i in range(0, CHANNELS, 3) if any(frame[i:i + 3])]}"
