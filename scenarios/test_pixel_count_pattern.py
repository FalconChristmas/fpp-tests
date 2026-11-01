"""The pixel count string tests (Output Specific tests 2 and 3), seen on the
wire as a pixel string port's bytes (tools/pixelstringdump.cpp)."""

import time

import pytest

from test_pixel_string_output import port_config, start, wire


@pytest.mark.parametrize("test", ["2", "3"])  # pixel count by port, by string
def test_the_pixel_count_test_holds_its_colours_as_the_cycles_go_by(fppd, test):
    """A 100 pixel port under the pixel count test shows the same pattern
    on every cycle: pixels 1-10 green, 11-20 red and so on in tens, with
    every 50th pixel white. Cycles come every 300 ms and the port is
    watched for ten of them.

    Regression: f57f7d543. The pattern's first colour was taken from the
    cycle number, so each cycle shifted the colours on from the last (red
    for the first ten pixels on the second cycle, blue on the third) and the
    test cycled colours instead of holding the pattern a count is read from.
    """
    start(fppd, port_config(fppd, 100))
    fppd.command("Test Start", "300", "Output Specific", "--ALL--", test)
    fppd.wait_for(lambda: (d := wire(fppd)) and len(d) == 300 and any(d), timeout=15,
                  what="the pixel count pattern on the port")
    seen = set()
    end = time.monotonic() + 3.1
    while time.monotonic() < end:
        d = wire(fppd)
        if d and len(d) == 300 and any(d):
            seen.add(bytes(d))
        time.sleep(0.02)
    fppd.command("Test Stop")
    assert len(seen) == 1, f"{len(seen)} different patterns, first pixels: {sorted(s[:3].hex() for s in seen)}"
    data = seen.pop()
    assert data[0:3] == bytes((0, 255, 0)) and data[27:33] == bytes((0, 255, 0, 255, 0, 0)), data[:36].hex(" ")
    assert data[147:150] == bytes((255, 255, 255)), data[144:153].hex(" ")
