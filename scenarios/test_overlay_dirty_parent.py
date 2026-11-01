"""Overlay model details around a model's node numbers and its parent."""

from ddp import DdpReceiver
from test_overlays import CHANNELS, fill, keeps_sending, matrix, setup, submodel, wait_output


def test_a_submodel_is_drawn_again_when_its_parent_changes(fppd):
    """A submodel stays on top of its parent when the parent is filled
    again: the parent's new fill covers the whole model, and the submodel's
    rectangle is drawn over it once more.

    Regression: 076ecd011. The submodel redrew only when its own buffer was
    dirty, so a parent change painted over it and it stayed gone."""
    setup(fppd, [matrix(), submodel("S", "M", 0, 0, 2, 1)])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "M", [0, 0, 50])
        wait_output(fppd, rx, lambda f: f[15:18] == bytes([0, 0, 50]), "the parent to fill")
        fill(fppd, "S", [200, 0, 0])
        wait_output(fppd, rx, lambda f: f[:6] == bytes([200, 0, 0] * 2), "the submodel to draw")
        fill(fppd, "M", [0, 0, 60])
        wait_output(fppd, rx, lambda f: f[15:18] == bytes([0, 0, 60]), "the parent to fill again")
        keeps_sending(rx)
        assert rx.last()[:6] == bytes([200, 0, 0] * 2), \
            f"the submodel was painted over by its parent: {rx.last()[:6].hex()}"


def test_a_custom_model_node_number_of_more_than_ten_characters_is_ignored(fppd):
    """A node number written with eleven digits draws nothing, rather than
    whatever node its low 32 bits make it.

    Regression: d77b6caf3. The text was converted unchecked: 42949672961 is
    10 * 2^32 + 1, so it drew as node 1."""
    custom = {"Name": "C", "Type": "Channel", "StartChannel": 1, "ChannelCount": 6,
              "ChannelCountPerNode": 3, "Orientation": "custom", "StartCorner": "TL",
              "StringCount": 1, "StrandsPerString": 1, "data": "2,42949672961"}
    setup(fppd, [custom])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "C", [0, 0, 55])
        wait_output(fppd, rx, lambda f: f[3:6] == bytes([0, 0, 55]), "node 2 to fill")
        keeps_sending(rx)
        assert rx.last()[:3] == bytes(3), \
            f"the eleven-digit node number drew as node 1: {rx.last()[:6].hex()}"

