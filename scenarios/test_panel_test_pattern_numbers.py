"""The numbers an LED panel output's own test pattern draws on each panel:
the output (at x = width/2 + 1) and the panel's place in its chain (at
width/2 + 8), as 3x5 white digits, captured off the wire from a ColorLight
output (see test_colorlight_output.py).
"""

from test_colorlight_output import captured, panel, panels_output

W, H = 32, 16

# The 3x5 digits LEDPanel::drawNumber() draws, row by row ("#" lit).
DIGITS = {
    0: ["###", "#.#", "#.#", "#.#", "###"],
    1: ["#..", "#..", "#..", "#..", "#.."],
    2: ["###", "..#", "###", "#..", "###"],
    3: ["###", "..#", "###", "..#", "###"],
}
WHITE = b"\xff\xff\xff"


def glyph(block, x0, y0):
    """The 3x5 window of a panel at (x0, y0), "#" where it is white."""
    return ["".join("#" if block[y0 + y][x0 + x] else "." for x in range(3)) for y in range(5)]


def panel_blocks(rows, chains):
    """Each panel's pixels as rows of booleans (white or not), one block per
    chain position of receiver rows 0..H-1."""
    blocks = []
    for c in range(chains):
        blocks.append([[rows[y][(c * W + x) * 3:(c * W + x) * 3 + 3] == WHITE for x in range(W)]
                       for y in range(H)])
    return blocks


def numbers(block):
    """(output, chain position) drawn on a panel: read upright, or turned
    half round for a panel mounted upside down -- whichever way up shows a
    digit where the output number goes."""
    for b in (block, [row[::-1] for row in block[::-1]]):
        out = [d for d, g in DIGITS.items() if glyph(b, W // 2 + 1, 1) == g]
        chain = [d for d, g in DIGITS.items() if glyph(b, W // 2 + 8, 1) == g]
        if out:
            return out[0], (chain[0] if chain else glyph(b, W // 2 + 8, 1))
    return None


def test_a_flipped_layouts_panels_are_numbered_by_their_chain_position(fppd):
    """Two 32x16 panels chained on one output of a ColorLight matrix saved
    before cfgVersion 2 (the flipped layout, each panel turned upside
    down): the Output Specific test pattern numbers them output 1, panels
    1 and 2.

    Regression: 931f017e1. Each output drew the numbers itself, and the
    ColorLight one turned the chain position round for a flipped layout:
    (longest chain - 1) - chain - 1, so the two panels showed 1 and 0.
    The number now comes from the panel (LEDPanel::drawTestPattern).
    """
    with captured() as cap:
        fppd.write("config/channeloutputs.json", panels_output(
            [panel(0, 0, 0, 0), panel(0, 1, W, 0)], channels=2 * W * H * 3, cfgVersion=1))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "1000", "Output Specific", "--ALL--", "1")

        def drawn():
            for _, rows in reversed(cap.frames()):
                if sorted(rows) == list(range(H)) and all(len(rows[r]) == 2 * W * 3 for r in rows):
                    got = [numbers(b) for b in panel_blocks(rows, 2)]
                    if all(got):
                        return got
            return None
        try:
            got = fppd.wait_for(drawn, timeout=15, interval=0.25, what="a test pattern frame with its numbers")
        finally:
            fppd.command("Test Stop")
    assert sorted(got) == [(1, 1), (1, 2)], got
