"""The pixel string testers' patterns on the wire, through the pixel string
dump output (tools/pixelstringdump.cpp) the way test_pixel_string_output.py
uses it."""

import time

from test_pixel_string_output import port_config, start, wire

GREEN, RED, BLUE, WHITE = bytes((0, 255, 0)), bytes((255, 0, 0)), bytes((0, 0, 255)), bytes((255, 255, 255))


def test_the_pixel_count_test_changes_colour_every_ten_pixels(fppd):
    """The pixel count by port test lights pixels green, red, blue in runs
    of ten -- pixels 1-10 green, 11-20 red, 21-30 blue -- with every 50th
    pixel white.

    Regression: b89d52401. The pixel number was bumped before the every-ten
    check, so the colour changed after the 9th pixel: runs of nine, and a
    count made by eye was off by one at every change."""
    start(fppd, port_config(fppd, 60))
    fppd.command("Test Start", "1000", "Output Specific", "--ALL--", "2")

    def lit():
        data = wire(fppd)
        return data if data and len(data) == 180 and any(data) else None
    data = fppd.wait_for(lit, timeout=15, interval=0.2, what="the pixel count test on the port")
    px = [data[i * 3:i * 3 + 3] for i in range(60)]
    assert px[0:10] == [GREEN] * 10, [p.hex() for p in px[:12]]
    assert px[10:20] == [RED] * 10, [p.hex() for p in px[8:22]]
    assert px[20:30] == [BLUE] * 10, [p.hex() for p in px[18:32]]
    assert px[49] == WHITE and px[48] != WHITE and px[50] != WHITE, [p.hex() for p in px[47:53]]
    fppd.command("Test Stop")


def test_an_unknown_string_test_number_lights_nothing(fppd):
    """A string test number beyond the list (8) is no string test: the port
    carries the channel data it is given, as with the test off, not the
    current-based pixel count pattern.

    Regression: 5790ddbfa. The check for the current-based test's number
    (999) was an assignment, which is always true, so every number past the
    list started the current-based pixel count."""
    start(fppd, port_config(fppd, 4))
    fppd.request("PUT", "/overlays/range/1-12", {"Value": 0x40})
    fppd.wait_for(lambda: wire(fppd) == bytes([0x40] * 12), timeout=10, what="the channels on the wire")
    fppd.command("Test Start", "1000", "Output Specific", "--ALL--", "8")
    time.sleep(3)
    assert wire(fppd) == bytes([0x40] * 12), wire(fppd)
    fppd.command("Test Stop")
