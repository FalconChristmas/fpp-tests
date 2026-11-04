"""Which row-address lines a BBShiftPanel cape's PRUs drive, in the shift
register row modes, read from the real PRUs' output registers (r30) while a
pattern runs. Panel test box only (a PocketBeagle2 with a PocketScroller
cape), under run-local.sh --host-pru; skipped elsewhere.

The control lines are fixed bits of the firmware's r30: the shift firmware
(PRU1, BBShiftPanel.asm) has A to E (SEL0-SEL4) on bits 11-15, and in the
usual two-PRU mode the OE firmware (PRU0, BBShiftPanel_oe.asm) has OE on
bit 0 (high is off); the GCLK firmware of the PWM panels (PRU0,
BBShiftPanel_gclk.asm) has A to E on bits 2-6. A shift register row driver
takes A as its clock, and its data on B (AB mode, active low) or C (ABC
mode, active high); the line a mode does not use is left alone.
"""

import time

import pytest

import pru
from pru import real_pru  # noqa: F401 (a fixture)
from test_am62x_panels import matrix, needs_panel_config, panels_config

AB_SHIFT, ABC_SHIFT = 1, 3
ICND1065L = 7
OE = 0                                       # PRU0 r30 (the OE firmware), high is off
A, B, C, D, E = 11, 12, 13, 14, 15          # PRU1 r30, the shift firmware
GA, GB, GC, GD, GE = 2, 3, 4, 5, 6          # PRU0 r30, the GCLK firmware


def sample(fppd, cores, samples=2500, **over):
    """A panel running a pattern, and `samples` reads of r30 of each of
    `cores`: a list of tuples, one value per core."""
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0,), **over)))
    fppd.start(timeout=90)
    needs_panel_config(fppd)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(4)
    seen = []
    with pru.Pruss() as p:
        for _ in range(samples):
            row = []
            for core in cores:
                assert p.halt(core), f"PRU{core} did not halt"
                row.append(p.register(core, 30))
            for core in cores:
                assert p.resume(core), f"PRU{core} did not stay running"
            seen.append(tuple(row))
            time.sleep(0.002)
        row_config = (p.dram(0, 0) >> 8) & 0xFF
    fppd.command("Test Stop")
    return seen, row_config


def ever(seen, bit, core=0):
    return any(v[core] >> bit & 1 for v in seen)


def test_the_abc_shift_data_line_is_low_while_a_row_is_displayed(real_pru, fppd):
    """An ABC-addressed panel's data line (C) is low whenever the display
    is on (OE low), so the row that is lit is never lit with C high.

    Regression: 461c03c4c. C was left at the last bit clocked, which is
    the active one for row 0, so it stayed high for row 0's whole display
    time and that row flickered.
    """
    seen, _ = sample(fppd, (0, 1), samples=8000, panelRowAddressType=ABC_SHIFT)
    on = [v for v in seen if not v[0] >> OE & 1]
    assert on and len(on) < len(seen), f"OE never moved ({len(on)} of {len(seen)} samples lit): the display never ran"
    lit_with_c = [v for v in on if v[1] >> C & 1]
    # The two cores are halted one after the other, so a sample taken as a
    # row's display ends and the next shift begins can read OE low and C
    # high: none in a few thousand samples on a good build, a handful at
    # most. With the line left high it is 0.1-0.35% of the lit samples (8 to
    # 28 of 8000), through the part of row 0 it stays high for.
    assert len(lit_with_c) <= 3, f"C high with the display on in {len(lit_with_c)} of {len(on)} lit samples"


@pytest.mark.parametrize("mode,data,other", [(ABC_SHIFT, C, B), (AB_SHIFT, B, C)], ids=["ABC", "AB"])
def test_a_shift_row_mode_drives_only_the_clock_and_its_data_line(real_pru, fppd, mode, data, other):
    """In a shift register row mode the line the mode doesn't use as data
    (B for ABC, C for AB) stays low, and D and E, which carry no row
    number here, are never driven.

    Regression: d9189aef3. One loop drove both B and C with the data
    whichever the mode used, so a panel using the other line for something
    else saw it toggling.
    """
    seen, _ = sample(fppd, (1,), panelRowAddressType=mode)
    assert ever(seen, A, 0) or ever(seen, data, 0), "neither the clock nor the data line ever went high"
    assert not ever(seen, other, 0), f"the unused row line (bit {other}) went high"
    assert not ever(seen, D, 0) and not ever(seen, E, 0), "D or E was driven"


def test_the_fm6373_token_shift_leaves_b_low(real_pru, fppd):
    """An ICND1065L panel on ABC Shift addressing (the PWM panels' token
    shift: A the row clock, C the data) never drives B; in standard
    addressing B is a bit of the binary row number and does move.

    Regression: f88c51e9d. The token shift was lifted from the DP3364
    scan, which holds B high through the row transition (a blanking input
    on that chip); on other panels B is something else and pulsed once per
    row.
    """
    abc, row_config = sample(fppd, (0,), samples=3000, panelType=ICND1065L, panelRowAddressType=ABC_SHIFT)
    assert row_config == 2, f"row config {row_config:#x}: the token shift was not selected"
    assert not ever(abc, GB), "B was driven in the token shift"


def test_the_fm6373_binary_row_number_does_drive_b(real_pru, fppd):
    """The control of the above: with standard addressing the same panel
    puts the binary row number on A to E, so B (bit 1 of it) moves. It is
    what shows the bit read above is the row line it is named for.
    """
    std, row_config = sample(fppd, (0,), samples=3000, panelType=ICND1065L, panelRowAddressType=0)
    assert row_config == 3, f"row config {row_config:#x}"
    assert ever(std, GB), "B never moved with a binary row number on it"
