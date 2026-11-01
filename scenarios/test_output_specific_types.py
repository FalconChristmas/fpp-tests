"""Test Start "Output Specific" with an output type chosen (the Output
Types argument of /fppd/testing/tests/Output Specific, "--ALL--" or one of
the types of the outputs that can draw a test): only outputs of that type
draw their test, captured off the wire from a ColorLight output (see
test_colorlight_output.py).
"""

import time

from test_colorlight_output import captured, panel, panels_output

W, H = 32, 16


def output_types(fppd):
    args = fppd.get("/fppd/testing/tests/Output%20Specific")["args"]
    (types,) = [a for a in args if a["name"] == "OutputTypes"]
    return types["contents"]


def lit_frames(cap):
    """How many of the frames captured so far have a lit pixel, and how many there are."""
    frames = [rows for _, rows in cap.frames() if rows]
    return sum(1 for rows in frames if any(any(r) for r in rows.values())), len(frames)


def start(fppd, cap, output_type):
    fppd.write("config/channeloutputs.json", panels_output([panel(0, 0, 0, 0)], channels=W * H * 3))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    types = output_types(fppd)
    assert types[0] == "--ALL--" and len(types) == 2, types
    # The control: the panel output is listed as a type that can draw a test.
    fppd.command("Test Start", "1000", "Output Specific", types[1] if output_type is None else output_type, "1")
    return types


def test_an_output_type_that_is_not_the_panels_draws_nothing_on_it(fppd):
    """Regression: 31afd8609. Output Specific tests took a type, so one
    kind of output could be tested alone. A test for a type the panel is
    not stayed dark on it (and the panel's own type, in the next test,
    lights it): before the type was looked at, every output drew."""
    with captured() as cap:
        start(fppd, cap, "NotAnOutputType")
        try:
            # frames are going out at all, and none of them has a lit pixel
            fppd.wait_for(lambda: lit_frames(cap)[1] >= 5, timeout=15, interval=0.25, what="frames on the wire")
            time.sleep(3)
            lit, total = lit_frames(cap)
            assert total >= 5 and lit == 0, f"{lit} of {total} frames drew a test for another type"
        finally:
            fppd.command("Test Stop")


def test_the_panels_own_output_type_draws_its_test(fppd):
    with captured() as cap:
        start(fppd, cap, None)
        try:
            fppd.wait_for(lambda: lit_frames(cap)[0] > 0, timeout=15, interval=0.25,
                          what="the panel to draw its test for its own type")
        finally:
            fppd.command("Test Stop")


def test_all_outputs_draw_when_no_type_is_chosen(fppd):
    with captured() as cap:
        start(fppd, cap, "--ALL--")
        try:
            fppd.wait_for(lambda: lit_frames(cap)[0] > 0, timeout=15, interval=0.25,
                          what="the panel to draw its test for --ALL--")
        finally:
            fppd.command("Test Stop")
