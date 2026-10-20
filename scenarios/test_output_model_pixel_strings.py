"""ModelPixelStrings: pixel strings drawn into an overlay model.

It runs the same PixelString code BBB48String, BBShiftString and DPIPixels
use (virtual strings, colour orders, gamma, null nodes), but writes into a
model instead of a PRU or DPI buffer, so it reaches that code anywhere. Each
string becomes a row of the model; the model is a Channel model over
channels 1001 on, and a DDP output carries those channels to a receiver.
"""

import time

from ddp import DdpReceiver

MODEL = "MPS"
WIDTH, HEIGHT = 20, 4
MODEL_START = 1001
FPPD_MAX_CHANNELS = 8388608


def model(fppd):
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": MODEL, "Type": "Channel", "StartChannel": MODEL_START,
        "ChannelCount": WIDTH * HEIGHT * 3, "ChannelCountPerNode": 3,
        "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": HEIGHT, "StrandsPerString": 1}]})


def vstring(start=0, pixels=10, order="RGB", gamma="1.0", **extra):
    """One virtual string reading `pixels` nodes from 0-based channel `start`."""
    vs = {"description": "test", "startChannel": start, "pixelCount": pixels,
          "colorOrder": order, "nullNodes": 0, "endNulls": 0, "groupCount": 0,
          "reverse": 0, "zigZag": 0, "brightness": 100, "gamma": gamma}
    vs.update(extra)
    return vs


def mps(strings, model_name=MODEL, description="mps"):
    """co-other.json: one ModelPixelStrings output, one port per string."""
    return {"channelOutputs": [{
        "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1, "channelCount": 240,
        "description": description, "modelName": model_name,
        "outputs": [{"portNumber": i, "protocol": "ws2811", "virtualStrings": [vs]}
                    for i, vs in enumerate(strings)]}]}


def ddp_model_channels():
    """co-universes.json: a DDP output carrying the model's channels."""
    n = WIDTH * HEIGHT * 3
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": MODEL_START, "channelCount": n,
        "universes": [{"active": 1, "description": "model", "id": 64001,
                       "startChannel": MODEL_START, "channelCount": n, "type": 5,
                       "address": "127.0.0.1", "priority": 0, "monitor": 0,
                       "deDuplicate": 0}]}]}


def warned(fppd, text):
    return any(text in w for w in fppd.get("/fppd/status").get("warnings", []))


def set_range(fppd, first, last, value):
    fppd.request("PUT", f"/overlays/range/{first}-{last}", {"Value": value})


def test_a_w_first_string_loads_without_writing_past_its_map(fppd):
    """A 9-pixel WRGB string, the last on its port, loads without writing
    past its channel map, and fppd lives. (Since 3710f07ca the output then
    refuses the string as not 8 bit RGB; the map is built before that.)

    Regression: 74336bf07. For the six W-first orders SetupMap() wrote W at
    the node base and then R, G and B one slot late, so the last pixel wrote
    one entry past m_outputMap: a heap-buffer-overflow at startup.
    """
    model(fppd)
    # 9 pixels: 36 bytes, a whole number of RGB steps, so that before
    # 3710f07ca refused the string PrepData() still stayed inside its maps.
    fppd.write("config/co-other.json", mps([vstring(order="WRGB", pixels=9)]))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                  timeout=10, what="the ModelPixelStrings output to load")
    time.sleep(2)


def test_an_rgbw_string_is_refused(fppd):
    """An RGBW string (four bytes a pixel) is refused with a warning, and
    fppd lives through test mode over its channels.

    Regression: 3710f07ca. PrepData() stepped three bytes a pixel through a
    40-byte string, so its last step read m_outputMap and the brightness
    maps at 40 and 41: a heap-buffer-overflow on the first frame.
    """
    model(fppd)
    fppd.write("config/co-other.json", mps([vstring(order="RGBW")]))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Test Start", "100", "RGB Cycle", "1-40", "R-G-B")
    fppd.wait_for(lambda: warned(fppd, "not 8 bit RGB"), timeout=10,
                  what="the not-8-bit-RGB warning")
    time.sleep(3)


def test_a_string_running_past_the_last_channel_is_refused(fppd):
    """A virtual string that starts inside the channel buffer but runs 30
    channels past its end is refused with a warning, and the output does not
    load; one that ends exactly at the last channel (the control) loads with
    no warning.

    Regression: 5c3e12719. Only the start was checked, so the string loaded
    and read past the end of the channel buffer every frame. (The buffer is
    an mmap a page past the end, which ASan does not track, so the test pins
    the validation rather than the over-read.)
    """
    model(fppd)
    fppd.write("config/co-other.json", {"channelOutputs": [
        mps([vstring(start=FPPD_MAX_CHANNELS - 30, pixels=20)], description="past")["channelOutputs"][0],
        mps([vstring(start=FPPD_MAX_CHANNELS - 60, pixels=20)], description="exact")["channelOutputs"][0],
    ]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: warned(fppd, "vsEnd > FPPD_MAX_CHANNELS"), timeout=10,
                  what="the string-runs-past-the-end warning")
    refused = [w for w in fppd.get("/fppd/status").get("warnings", [])
               if "Could not initialize output type ModelPixelStrings" in w]
    assert len(refused) == 1, f"want exactly the overrunning output refused: {refused}"


def test_a_nan_gamma_leaves_dark_channels_dark(fppd):
    """A virtual string with "gamma": "nan" (a hand edit) keeps channels
    that are 0 at 0: half the string's input is lit, the other half dark,
    and the dark half reaches the model as 0.

    Regression: 17929fe5c. NaN passed the gamma clamps (every comparison
    with NaN is false), and the curve built from it put every channel,
    0 included, out at full.
    """
    model(fppd)
    fppd.write("config/co-other.json", mps([vstring(pixels=10, gamma="nan")]))
    fppd.write("config/co-universes.json", ddp_model_channels())
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(WIDTH * HEIGHT * 3) as rx:
        fppd.start()
        set_range(fppd, 1, 15, 0x40)
        fppd.wait_for(lambda: rx.last() is not None and any(rx.last()[:15]), timeout=10,
                      what="the lit half of the string in the model")
        time.sleep(1)
        frame = rx.last()
    dark = frame[15:30]
    assert dark == bytes(15), f"channels at 0 went out as {dark.hex(' ')}"


PANEL_START = 1001
PANEL_MODEL = "LED Panels"  # the name ColorLight gives the model it creates


def panels_with_strings(fppd, cap_note="a"):
    """A ColorLight panel (channels 1001 on, auto-creating "LED Panels")."""
    from test_colorlight_output import panel, panels_output
    return panels_output([panel(0, 0, 0, 0)], channels=32 * 16 * 3,
                         startChannel=PANEL_START, note=cap_note)


def test_strings_follow_a_model_another_output_recreates(fppd):
    """ModelPixelStrings drawing into the model a ColorLight output creates
    survives that output's config being saved twice -- each save removes the
    model and creates a new one -- with frames flowing throughout.

    co-other.json is loaded before channeloutputs.json, so the strings are
    written once fppd is up and the model exists.

    Regression: 3710f07ca. ModelPixelStrings kept a bare pointer to the
    model, and RawSendData() handed the next frame to the freed one: a
    heap-use-after-free after the first save.
    """
    from test_colorlight_output import captured
    with captured():
        fppd.write("config/channeloutputs.json", panels_with_strings(fppd))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.wait_for(lambda: any(m.get("Name") == PANEL_MODEL for m in fppd.get("/models")),
                      timeout=10, what="the panel's model")
        fppd.write("config/co-other.json", mps([vstring(pixels=10)], model_name=PANEL_MODEL))
        fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                      timeout=10, what="the ModelPixelStrings output to load")
        set_range(fppd, 1, 30, 0x40)
        for i in range(2):
            time.sleep(1.1)  # a save in a later second, as a person makes it
            fppd.write("config/channeloutputs.json", panels_with_strings(fppd, f"save {i}"))
        time.sleep(3)
        fppd.check_alive()
    loads = fppd.log().count("Calling Init() on ColorLight5a75 output")
    assert loads >= 3, f"the panel output loaded {loads} times for 2 saves"


def test_a_nan_gamma_takes_the_default(fppd):
    """A virtual string with "gamma": "nan" uses the default gamma (1.0):
    input 0x40 reaches the model as 0x40.

    Regression: 4d908c730. PixelString mapped a NaN gamma to the 0.01
    floor, not the default: 0x40 came out at about 0xFB, so a dim show ran
    near full brightness.
    """
    model(fppd)
    fppd.write("config/co-other.json", mps([vstring(pixels=10, gamma="nan")]))
    fppd.write("config/co-universes.json", ddp_model_channels())
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(WIDTH * HEIGHT * 3) as rx:
        fppd.start()
        set_range(fppd, 1, 15, 0x40)
        fppd.wait_for(lambda: rx.last() is not None and any(rx.last()[:15]), timeout=10,
                      what="the lit half of the string in the model")
        time.sleep(1)
        lit = rx.last()[:15]
    assert lit == bytes([0x40]) * 15, f"0x40 went out as {lit.hex(' ')}"


def test_strings_still_draw_after_the_model_is_recreated(fppd):
    """ModelPixelStrings drawing into the model a ColorLight output creates
    still reaches the panel after that output's config is saved: the first
    ten pixels of row 0 show the strings' input (0x40) before the save and
    after it.

    Regression: e9e393704. 3710f07ca made the output follow the re-created
    model but never enabled it; a new model starts disabled, so after the
    save setData() filled a buffer that was never overlaid, and the panel
    went dark with no log line.
    """
    from test_colorlight_output import captured

    def row0_lit(cap):
        fs = cap.frames()
        return bool(fs) and 0 in fs[-1][1] and fs[-1][1][0][:30] == bytes([0x40]) * 30

    with captured() as cap:
        fppd.write("config/channeloutputs.json", panels_with_strings(fppd))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.wait_for(lambda: any(m.get("Name") == PANEL_MODEL for m in fppd.get("/models")),
                      timeout=10, what="the panel's model")
        fppd.write("config/co-other.json", mps([vstring(pixels=10)], model_name=PANEL_MODEL))
        fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                      timeout=10, what="the ModelPixelStrings output to load")
        set_range(fppd, 1, 30, 0x40)
        fppd.wait_for(lambda: row0_lit(cap), timeout=10, interval=0.2,
                      what="the strings on the panel before the save")
        time.sleep(1.1)
        fppd.write("config/channeloutputs.json", panels_with_strings(fppd, "saved"))
        time.sleep(3)
        fppd.wait_for(lambda: row0_lit(cap), timeout=10, interval=0.2,
                      what="the strings on the panel after the save")
