"""The WS2811-family part names the Pixel Strings page offers for a
BBShiftString port (c5cce457b), read by fppd's PixelString: every one is
drawn exactly as ws2811 is.

ModelPixelStrings runs the same PixelString code as the BeagleBone and
DPIPixels string outputs (see test_output_model_pixel_strings.py), so a
port's protocol shows in what it draws into the model: one port per name,
each reading the same five input pixels into its own row.  The bit cell a
name selects (PixelString::protocolTiming) only reaches a BBShiftString PRU,
which Docker does not have.  The page's half is
web/tests/pixel-strings-page.spec.ts.
"""

import json
import pathlib
import re
import os

from test_output_model_pixel_strings import set_range, vstring

MODEL = "Aliases"
WIDTH = 5


def names_from_page():
    """PIXEL_PROTOCOLS_WS281X as the tree's co-pixelStrings.php lists it."""
    php = pathlib.Path(os.environ["FPP_TREE"], "www/co-pixelStrings.php").read_text()
    block = re.search(r"var PIXEL_PROTOCOLS_WS281X = \[(.*?)\]\.join", php, re.S).group(1)
    block = re.sub(r"//[^\n]*", "", block)
    return re.findall(r"'([^']+)'", block)


def test_every_ws2811_family_name_is_drawn_as_ws2811(fppd):
    """A port set to any of the WS2811-family names draws the input pixels
    exactly as a ws2811 port does.  The control is tm1814, a part the page
    lists beside them that really differs (an inverted line and a current
    preamble), which does not.

    Receiving end of c5cce457b (the fix is the page's list; fppd's reading
    of the names is unchanged by it): it shows the names are labels, as the
    commit says, and that picking one changes nothing on the wire.
    """
    names = names_from_page()
    assert "sk6812" in names and "ws2811" in names, names
    protocols = ["ws2811"] + [n for n in names if n != "ws2811"] + ["tm1814"]
    height = len(protocols)
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": MODEL, "Type": "Channel", "StartChannel": 1001,
        "ChannelCount": WIDTH * height * 3, "ChannelCountPerNode": 3,
        "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": height, "StrandsPerString": 1}]})
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1, "channelCount": WIDTH * 3,
        "description": "aliases", "modelName": MODEL,
        "outputs": [{"portNumber": i, "protocol": p, "virtualStrings": [vstring(start=0, pixels=WIDTH)]}
                    for i, p in enumerate(protocols)]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "Calling Init() on ModelPixelStrings output" in fppd.log(),
                  timeout=10, what="the ModelPixelStrings output to load")
    last = WIDTH * 3
    for ch in range(1, last + 1):
        set_range(fppd, ch, ch, 10 + ch)

    def settled():
        d = fppd.get(f"/overlays/model/{MODEL}/data").get("data") or []
        return d if (10 + last) in d else None

    got = fppd.wait_for(settled, timeout=10, what="the input pixels to reach the model")
    rows = {p: got[r * WIDTH * 3:(r + 1) * WIDTH * 3] for r, p in enumerate(protocols)}
    want = [10 + ch for ch in range(1, last + 1)]
    assert rows["ws2811"] == want, f"ws2811 drew {rows['ws2811']}"
    differ = {p: rows[p] for p in protocols[1:-1] if rows[p] != want}
    assert not differ, f"drawn unlike ws2811: {json.dumps(differ)}"
    assert rows["tm1814"] != want, "the control: tm1814 drew the same as ws2811"
