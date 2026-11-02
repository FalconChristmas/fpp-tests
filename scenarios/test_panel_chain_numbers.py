"""The chain position an LED panel output's own test pattern draws on each
panel, along the chain in the order the panels are wired (see
test_panel_test_pattern_numbers.py for the drawing itself)."""

from test_colorlight_output import captured, panel, panels_output
from test_panel_test_pattern_numbers import H, W, numbers, panel_blocks


def test_chained_panels_are_numbered_from_the_first_in_the_chain(fppd):
    """Three 32x16 panels chained on one output of a ColorLight matrix,
    unflipped: the first panel in the chain shows chain position 1, the
    next 2 and the last 3 -- not counted back from the end. (A ColorLight
    chain's pixel data goes farthest panel first, so the blocks come off
    the wire as 3, 2, 1.)

    Regression: 075049e8c. The BBB panel output counted the chain
    backwards (panels on the output minus its place), so the first panel
    read as the last. The number now comes from the panel itself
    (LEDPanel::drawTestPattern).
    """
    with captured() as cap:
        fppd.write("config/channeloutputs.json", panels_output(
            [panel(0, c, c * W, 0) for c in range(3)], channels=3 * W * H * 3))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "1000", "Output Specific", "--ALL--", "1")

        def drawn():
            for _, rows in reversed(cap.frames()):
                if sorted(rows) == list(range(H)) and all(len(rows[r]) == 3 * W * 3 for r in rows):
                    got = [numbers(b) for b in panel_blocks(rows, 3)]
                    if all(got):
                        return got
            return None
        try:
            got = fppd.wait_for(drawn, timeout=15, interval=0.25, what="a test pattern frame with its numbers")
        finally:
            fppd.command("Test Stop")
    assert got == [(1, 3), (1, 2), (1, 1)], got
