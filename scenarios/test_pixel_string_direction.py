"""A pixel string's Direction, as the Pixel Strings page saves it, read by
fppd's PixelString.

ModelPixelStrings runs the same PixelString code as the BeagleBone and
DPIPixels string outputs (see test_output_model_pixel_strings.py), so the
order a string is drawn in can be read back from the model it draws into.
The page's half is web/tests/pixel-strings-page.spec.ts.
"""

from test_output_model_pixel_strings import MODEL, WIDTH, HEIGHT, model, set_range, vstring

PIXELS = 5


def test_a_string_saved_reverse_is_drawn_reversed_and_a_null_direction_forward(fppd):
    """Two strings read the same five input pixels: the one saved with
    "reverse": 1 draws them last to first, and the one saved with
    "reverse": null -- what the page wrote for every string before
    182255979 -- draws them first to last, as Forward.

    Receiving end of 182255979 (the fix is in the page; fppd's reading of
    the field is unchanged): it shows why the null the page saved lost the
    Reverse a user had picked.
    """
    model(fppd)
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1, "channelCount": PIXELS * 3,
        "description": "direction", "modelName": MODEL,
        "outputs": [
            {"portNumber": 0, "protocol": "ws2811",
             "virtualStrings": [vstring(start=0, pixels=PIXELS, reverse=1)]},
            {"portNumber": 1, "protocol": "ws2811",
             "virtualStrings": [vstring(start=0, pixels=PIXELS, reverse=None)]}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                  timeout=10, what="the ModelPixelStrings output to load")
    last = PIXELS * 3
    for ch in range(1, last + 1):
        set_range(fppd, ch, ch, ch)

    def settled():
        d = fppd.get(f"/overlays/model/{MODEL}/data").get("data") or []
        return d if last in d else None

    got = fppd.wait_for(settled, timeout=10, what="the last channel set to reach the model")
    assert len(got) == WIDTH * HEIGHT * 3, f"read back {len(got)} bytes"

    def row(r):
        """The 1-based input channel of the R of each of the row's first pixels."""
        return [got[(r * WIDTH + p) * 3] for p in range(PIXELS)]

    forward = [3 * p + 1 for p in range(PIXELS)]
    assert row(0) == forward[::-1], f"the Reverse string drew {row(0)}"
    assert row(1) == forward, f"the null-direction string drew {row(1)}"
