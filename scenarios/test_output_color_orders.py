"""Pixel string colour orders: each of the six three-channel orders puts a
pixel's R, G and B on the wire in that order.

ModelPixelStrings runs the PixelString mapping that BBB48String,
BBShiftString and DPIPixels use, but writes each string into a row of an
overlay model, where the wire bytes can be read back.
"""

from test_output_model_pixel_strings import vstring

MODEL = "Orders"
ORDERS = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"]
PIXELS = 5
MODEL_START = 1001


def test_each_colour_order_reaches_the_wire_in_that_order(fppd):
    """Six 5-pixel strings, one per colour order, each reading its own 15
    input channels; input channel n carries the value n. Read back from the
    model, every pixel of the string for order XYZ holds that pixel's X, Y
    and Z channel values, in that order.

    Regression: 6deab3e88. PixelString's map had GBR and BRG the wrong way
    round, so a GBR string sent B, R, G and a BRG string sent G, B, R. (The
    parent predates the move to Drogon and does not build here; shown red
    by swapping the two orders back in SetupMap() on master.)
    """
    rows = len(ORDERS)
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": MODEL, "Type": "Channel", "StartChannel": MODEL_START,
        "ChannelCount": PIXELS * rows * 3, "ChannelCountPerNode": 3,
        "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": rows, "StrandsPerString": 1}]})
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1,
        "channelCount": PIXELS * rows * 3, "description": "orders", "modelName": MODEL,
        "outputs": [{"portNumber": i, "protocol": "ws2811",
                     "virtualStrings": [vstring(start=i * PIXELS * 3, pixels=PIXELS, order=o)]}
                    for i, o in enumerate(ORDERS)]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                  timeout=10, what="the ModelPixelStrings output to load")
    last = PIXELS * rows * 3
    for ch in range(1, last + 1):
        fppd.request("PUT", f"/overlays/range/{ch}-{ch}", {"Value": ch})

    def settled():
        # every frame lays all the channels at once, so once the last one
        # set shows (wherever it lands) they all have
        d = fppd.get(f"/overlays/model/{MODEL}/data").get("data") or []
        return d if last in d else None

    got = fppd.wait_for(settled, timeout=10, what="the last channel set to reach the model")
    wrong = []
    for r, order in enumerate(ORDERS):
        for p in range(PIXELS):
            red = r * PIXELS * 3 + p * 3 + 1  # the pixel's R input channel, and its value
            want = [red + "RGB".index(c) for c in order]
            at = (r * PIXELS + p) * 3
            if got[at:at + 3] != want:
                wrong.append(f"{order} pixel {p}: {got[at:at + 3]} != {want}")
    assert not wrong, "colour order wrong on the wire: " + "; ".join(wrong[:8])
