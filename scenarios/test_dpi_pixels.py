"""DPIPixels cape string configs that don't fit its tables.

Device only: run with run-local.sh on a Raspberry Pi with an ASan build (the
16K-page kernel; ASan can't start on the 4K one). Cape string configs are read
from /opt/fpp/capes/pi/strings, which run-local.sh overlays, so the scenario's
own config lands only in its scratch layer. Init may still fail afterwards for
want of a DPI display connector; only what happens before that matters here.
"""

import json
import os

import pytest

from fppd import sanitizer

CAPES = "/opt/fpp/capes/pi/strings"


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


def write_cape(name, cape):
    os.makedirs(CAPES, exist_ok=True)
    with open(os.path.join(CAPES, name + ".json"), "w") as f:
        json.dump(cape, f)


def output(port, pixels, start):
    return {"portNumber": port, "protocol": "ws2811", "virtualStrings": [
        {"description": f"port{port}", "startChannel": start, "pixelCount": pixels,
         "groupCount": 0, "reverse": 0, "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0,
         "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}


@pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")
def test_a_shared_output_index_past_the_outputs_is_refused(fppd):
    """A cape output sharing an output index that doesn't exist (1000) is
    left off, with an error, instead of reading past the pin list.

    Regression: 2324d312b. outputPinMap[sharedOutput] was indexed
    unchecked: an ASan heap-buffer-overflow at startup.
    """
    if sanitizer(fppd.tree) != "asan":
        pytest.skip("needs an ASan build to see the over-read")
    write_cape("TestDPI", {"outputs": [{"pin": "P1-7"}, {"sharedOutput": 1000}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestDPI", "enabled": 1, "startChannel": 1,
         "channelCount": 60, "outputCount": 2, "outputs": [output(0, 10, 0), output(1, 10, 30)]}]})
    fppd.start()
    assert "shares output 1001, which has no DPI pin" in fppd.log(), fppd.tail()
