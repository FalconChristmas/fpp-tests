"""The red, green, blue and white fade string tests, and a port's
brightness, on the wire through the pixel string dump output the way
test_pixel_string_output.py uses it."""

import time

import pytest

from test_pixel_string_output import port_config, start, wire

PIXELS = 4


@pytest.mark.parametrize("test, lit", [("4", (0,)), ("5", (1,)), ("6", (2,)), ("7", (0, 1, 2))],
                         ids=["red", "green", "blue", "white"])
def test_a_fade_test_fades_only_its_own_channels(fppd, test, lit):
    """The red, green, blue and white fade tests (Output Specific tests 4
    to 7) fade just the red, green, blue, or all three channels of every
    pixel on an RGB port, and leave the others dark.

    Regression: b7b0d605d. The fade testers were added with the colour
    chosen from the colour order's offsets: a fade lit on the wrong
    channel (or none, or all) is a string tester that reports the wrong
    colour at a pixel.
    """
    start(fppd, port_config(fppd, PIXELS))
    fppd.command("Test Start", "1000", "Output Specific", "--ALL--", test)
    seen = []

    def fading():
        data = wire(fppd)
        if data and len(data) == PIXELS * 3 and any(data):
            seen.append(data)
        return len(seen) >= 4 or None
    fppd.wait_for(fading, timeout=20, interval=0.1, what="the fade on the port")
    fppd.command("Test Stop")
    for data in seen:
        for px in range(PIXELS):
            got = data[px * 3:px * 3 + 3]
            for ch in range(3):
                if ch not in lit:
                    assert got[ch] == 0, (test, data.hex(" "))
            if len(lit) == 3:
                assert got[0] == got[1] == got[2], (test, data.hex(" "))
    assert max(max(d) for d in seen) > 0


def test_a_ports_brightness_scales_the_channels_it_sends(fppd):
    """A port at 50% brightness (gamma 1.0) puts 0x40 channels on the
    wire as 0x20 -- through the port's own output buffer, as every pixel
    string driver takes its frame.

    Regression: 1b0b12f9f. PixelString::prepareOutput() is where the
    string drivers now get their frame (and the testers' data) instead
    of each walking the virtual strings; the brightness map is applied
    there.
    """
    port = port_config(fppd, 4)
    port["virtualStrings"][0]["brightness"] = 50
    start(fppd, port)
    fppd.request("PUT", "/overlays/range/1-12", {"Value": 0x40})
    fppd.wait_for(lambda: (d := wire(fppd)) and len(d) == 12 and d[-1] != 0, timeout=10,
                  what=f"the channels on the wire (last {wire(fppd)!r})")
    assert wire(fppd) == bytes([0x20] * 12), wire(fppd).hex(" ")
