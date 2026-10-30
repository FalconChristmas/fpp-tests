"""A Virtual Matrix output reconfigured while fppd runs: the framebuffer
model it creates for its device ("FB - <device>") follows the saved
config, without a restart. The device is framebuffer.py's fake fb1."""

import time

from framebuffer import FakeFb
from test_display_outputs import virtual_matrix

MODEL = "FB - fb1"


def fb_models(fppd):
    return {m["Name"]: m for m in fppd.get("/models") or [] if m.get("Name") == MODEL}


def save(fppd, outputs):
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-other.json", {"channelOutputs": outputs})


def test_a_removed_virtual_matrix_takes_its_framebuffer_model_with_it(fppd):
    """A Virtual Matrix on fb1 creates the "FB - fb1" model; saved again at
    32x16 the model is re-created at that size, and saved with the output
    deleted the model goes, all without restarting fppd.

    Regression: 97263c979. Close() never removed the FB model the output had
    auto-created, so it outlived the output: deleting the Virtual Matrix
    left "FB - fb1" behind until fppd was restarted. (Its other half,
    re-creating the model at a new size on a save, is also done since by
    Init() removing a model of that name first, so only the deletion tells
    the fix apart now.)
    """
    fb = FakeFb(fppd, width=64, height=32, bpp=32)
    fppd.write("config/co-other.json", {"channelOutputs": [virtual_matrix(64, 32)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.wait_for(lambda: fb_models(fppd).get(MODEL, {}).get("ChannelCount") == 64 * 32 * 3,
                  timeout=15, what="the 64x32 FB model")

    save(fppd, [virtual_matrix(32, 16)])
    fppd.wait_for(lambda: fb_models(fppd).get(MODEL, {}).get("ChannelCount") == 32 * 16 * 3,
                  timeout=15, what="the FB model re-created at 32x16")

    save(fppd, [])
    fppd.wait_for(lambda: not fb_models(fppd), timeout=10,
                  what="the deleted Virtual Matrix's FB model to go")
    fppd.check_alive()
