"""A Virtual Matrix driving a submodel of a framebuffer model: one region of
a larger HDMI screen, filled from the matrix's own channels with nothing
else drawing on the screen (pass-through, no overlay effect running).

The submodel is never enabled in this setup, so nothing calls its
setState(), which until then was the only thing that looked its parent up:
it drew nothing.  The manager now resolves a submodel's parent whenever
either model is added.

Runs anywhere, Docker included: the display is the fake card of fakedrm.c
(see fakedrm.py).
"""

from urllib.parse import quote

import fakedrm

W, H = 64, 32             # the screen model
SX, SY, SW, SH = 8, 4, 16, 8  # the region the Virtual Matrix drives
CHANNELS = SW * SH * 3


def submodel(parent):
    """A rectangle of `parent`, as the UI's Sub model dialog saves it."""
    return {"Name": "Region", "Type": "Sub", "Parent": parent,
            "XOffset": SX, "YOffset": SY, "Width": SW, "Height": SH,
            "StartChannel": 1, "ChannelCount": CHANNELS, "ChannelCountPerNode": 3,
            "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": SH, "StrandsPerString": 1}


def region_matrix():
    return {"enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": CHANNELS,
            "modelName": "Region"}


def screen_matrix(start):
    """A Virtual Matrix on the whole screen, which auto-creates its model
    ("FB - HDMI-A-1") and so re-creates it on every output reload."""
    return {"enabled": 1, "type": "VirtualMatrix", "startChannel": start, "channelCount": W * H * 3,
            "device": fakedrm.CONNECTOR, "width": W, "height": H}


def pixels(fppd, model):
    data = fppd.get(f"/overlays/model/{quote(model)}/data").get("data") or []
    return [tuple(data[i:i + 3]) for i in range(0, len(data), 3)]


def region_lit(fppd, model):
    """Every pixel of the region is lit, by the test pattern on its channels."""
    px = pixels(fppd, model)
    if len(px) != W * H:
        return False
    return all(px[(SY + y) * W + SX + x] != (0, 0, 0) for y in range(SH) for x in range(SW))


def start(fppd):
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)


def test_a_virtual_matrix_draws_into_a_framebuffer_submodel_listed_before_its_parent(fppd):
    """The submodel comes before its parent in model-overlays.json, so the
    parent is not there when the submodel is loaded.  Driven by its Virtual
    Matrix, the submodel's region of the screen lights up, and only that
    region.

    Fix: a40085735 (PixelOverlayManager::addModel() resolves submodels)."""
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        submodel("Screen"),
        {"Name": "Screen", "Type": "FB", "Device": fakedrm.CONNECTOR, "Width": W, "Height": H},
    ]})
    fppd.write("config/co-other.json", {"channelOutputs": [region_matrix()]})
    start(fppd)
    fppd.command("Test Start", "1000", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
    fppd.wait_for(lambda: region_lit(fppd, "Screen"), timeout=10,
                  what="the submodel's region of the screen to be drawn")
    px = pixels(fppd, "Screen")
    outside = [i for i, p in enumerate(px)
               if p != (0, 0, 0) and not (SX <= i % W < SX + SW and SY <= i // W < SY + SH)]
    assert not outside, f"{len(outside)} pixels outside the region were drawn, first at {outside[0]}"
    fppd.command("Test Stop")


def test_a_framebuffer_submodel_keeps_drawing_after_its_parent_is_recreated(fppd):
    """The parent is the model another Virtual Matrix auto-creates for the
    whole screen.  An output reload deletes and re-creates that model, which
    lets every submodel of it go; the region's Virtual Matrix draws into the
    new one all the same.

    The screen's output comes first: both draw in pass-through, and the one
    sent later wins where they overlap (warning-35.md), so with the region
    first the screen's own, unlit, channels covered it on every frame.

    Fix: as above (resolved when the parent is added, not only in the
    output's Init())."""
    parent = f"FB - {fakedrm.CONNECTOR}"
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [submodel(parent)]})
    outputs = [screen_matrix(CHANNELS + 1), region_matrix()]
    fppd.write("config/co-other.json", {"channelOutputs": outputs})
    start(fppd)
    fppd.command("Test Start", "1000", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
    fppd.wait_for(lambda: region_lit(fppd, parent), timeout=10,
                  what="the region of the auto-created screen model to be drawn")

    mode_line = f"KMSFrameBuffer: {fakedrm.CONNECTOR} mode"
    seen = fppd.log().count(mode_line)
    outputs[0]["comment"] = "saved again"  # the same outputs, saved again: a reload
    fppd.write("config/co-other.json", {"channelOutputs": outputs})
    fppd.wait_for(lambda: fppd.log().count(mode_line) > seen, timeout=15,
                  what="the reloaded screen Virtual Matrix")
    fppd.wait_for(lambda: region_lit(fppd, parent), timeout=10,
                  what="the region to be drawn again after the reload")
    fppd.command("Test Stop")


def test_a_virtual_matrix_refuses_a_submodel_of_a_pixel_model(fppd):
    """Only a framebuffer is drawn from a Virtual Matrix's SendData(); a
    submodel of a channel (pixel) model would write the sequence channels
    after the outputs ahead of it had sent them.  The output says so and
    stays off.  Fix: a40085735."""
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Pixels", "Type": "Channel", "StartChannel": 1001, "ChannelCount": W * H * 3,
         "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
         "StringCount": H, "StrandsPerString": 1},
        submodel("Pixels"),
    ]})
    fppd.write("config/co-other.json", {"channelOutputs": [region_matrix()]})
    start(fppd)
    fppd.wait_for(lambda: "is a submodel of 'Pixels', which is not a framebuffer" in fppd.log(),
                  timeout=10, what="the Virtual Matrix to refuse the submodel")
    fppd.wait_for(lambda: any("not a framebuffer" in w for w in fppd.get("/fppd/status").get("warnings", [])),
                  timeout=10, what="the output config warning")
