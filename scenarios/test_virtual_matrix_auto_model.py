"""The overlay model a Virtual Matrix creates for itself under Auto-create
Pixel Overlay Models, beside the framebuffer model ("FB - <device>") it
creates for its device. The device is framebuffer.py's fake fb1."""

from framebuffer import FakeFb
from test_display_outputs import virtual_matrix

CHANNELS = 32 * 16 * 3


def models(fppd):
    return {m["Name"]: m for m in fppd.get("/models") or []}


def test_a_virtual_matrix_gets_a_model_named_after_its_description(fppd):
    """With Auto-create Pixel Overlay Models on, a Virtual Matrix saved
    with a description gets a model of that name over its channels; a
    second with the same description gets "<description>-1".

    Regression: 0cda5f5c7. The auto-creation had been switched off for
    Virtual Matrices, so the page's Auto-create option made nothing for
    them."""
    fb = FakeFb(fppd, width=32, height=16, bpp=32)
    first = dict(virtual_matrix(32, 16), description="Screen")
    second = dict(virtual_matrix(32, 16, start=CHANNELS + 1), description="Screen")
    fppd.write("config/co-other.json", {"channelOutputs": [first, second]})
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.wait_for(lambda: {"Screen", "Screen-1"} <= set(models(fppd)), timeout=15,
                  what=f"the two matrices' models (have {sorted(models(fppd))})")
    have = models(fppd)
    assert (have["Screen"]["StartChannel"], have["Screen"]["ChannelCount"]) == (1, CHANNELS), have["Screen"]
    assert (have["Screen-1"]["StartChannel"], have["Screen-1"]["ChannelCount"]) == (CHANNELS + 1, CHANNELS), have["Screen-1"]
