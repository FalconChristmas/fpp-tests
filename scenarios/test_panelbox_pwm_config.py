"""What fppd hands the PRUs of a BBShiftPanel cape for a PWM-driver panel
(FM6373 family: ICND1065L here) and for an ABC Shift row driver, read back
from the real PRUs' data RAM.

Panel test box only: a PocketBeagle2 with a PocketScroller cape, run with
run-local.sh --host-pru and the device's own fppd stopped. The panel config
comes from the cape's EEPROM, which the other boards don't carry, so the
scenarios skip there (needs_panel_config). The PRU programs' effect on a
panel's pins can't be seen from the host, but the words they are given can:
the GCLK program's row config bytes in PRU0's data RAM, and the addressing
and register-upload words in PRU1's.

PRU0 (BBShiftPanel_gclk.asm) data RAM bytes: [1] row config (bit 0: direct
row select, bit 1: FM6373 scan), [2] opener pulse in us, [3] row period in
us, [5] OE pulse in 100 ns units. PRU1: 0x1DF8 the addressing/chip config
word, 0x1DFC the FM6373 register upload grammar.
"""

import time

import pytest

import pru
from pru import real_pru  # noqa: F401 (a fixture)
from test_am62x_panels import matrix, needs_panel_config, panels_config

ADDR_CONFIG = 0x1DF8
UPLOAD_GRAMMAR = ADDR_CONFIG + 4
ICND1065L = 7
ABC_SHIFT = 3
PWM_IMAGE = "/opt/fpp/src/non-gpl/BBShiftPanel/BBShiftPanel_pwm_16.out"
# the data clock period at 16 and at 8 outputs, BBShiftPanel.cpp
DCLK_NS_16, DCLK_NS_8 = 194, 109


def dclk_ns():
    """The data clock of the output count this cape runs: the 16 output
    firmware image is the one PRU1 was loaded with at 16 outputs."""
    with open("/lib/firmware/am62x-pru1-fw.fpp", "rb") as f, open(PWM_IMAGE, "rb") as g:
        return DCLK_NS_16 if f.read() == g.read() else DCLK_NS_8


def start_panel(fppd, **over):
    fppd.write("config/channeloutputs.json", panels_config(matrix(**over)))
    fppd.start(timeout=90)
    needs_panel_config(fppd)
    # the PWM firmware uploads its registers and starts streaming
    time.sleep(3)


def gclk_byte(n):
    with pru.Pruss() as p:
        return (p.dram(0, 4 * (n // 4)) >> (8 * (n % 4))) & 0xFF


def icnd(fppd, **over):
    start_panel(fppd, panelType=ICND1065L, **over)
    assert "Unable to start PRU" not in fppd.log()


@pytest.mark.parametrize("addressing,row_config", [
    (0, 3),          # Standard: a binary row number on SEL0-4, as before
    (1, 3),          # Direct Row Select, the same
    (ABC_SHIFT, 2),  # ABC Shift: the token shift register, bit 0 clear
])
def test_the_addressing_dropdown_reaches_the_fm6373_row_config(real_pru, fppd, addressing, row_config):
    """An ICND1065L panel's Panel Addressing Type reaches the GCLK program's
    row config: ABC Shift clears bit 0 so its A/B/C token shift block runs,
    anything else keeps the binary row number.

    Regression: 3e30b3395. sendPWMConfig() hard-coded the row config to 3,
    so the dropdown had no effect for the FM6373 family and a panel wired
    to a shift register never lit.
    """
    icnd(fppd, panelRowAddressType=addressing)
    got = gclk_byte(1)
    assert got == row_config, f"row config {got:#x} for addressing {addressing}, expected {row_config:#x}"


def test_unset_oe_timing_is_what_the_panel_always_got(real_pru, fppd):
    """With no OE timing in the config the PRU gets a 2 us opener, a 20 us
    row period and a 600 ns pulse (6 x 100 ns): what this family emitted
    before the timing was configurable.

    Regression: fbadc223e (adopting the reference implementation's own
    defaults would have retimed every existing panel).
    """
    icnd(fppd)
    assert (gclk_byte(2), gclk_byte(3), gclk_byte(5)) == (2, 20, 6)


def test_the_oe_timing_in_dclk_periods_reaches_the_gclk_program(real_pru, fppd):
    """panelOEClkLength and panelOEFirstClkLength count DCLK periods (the
    cape's data clock: 194 ns at 16 outputs, 109 ns at 8), panelOERowPeriodUs
    is in us: 10 / 20 / 40 arrive as a 20 (16 outputs) or 11 (8) pulse in
    100 ns units, a 4 or 3 us opener and a 40 us row period.

    Regression: fbadc223e.
    """
    icnd(fppd, panelOEClkLength=10, panelOEFirstClkLength=20, panelOERowPeriodUs=40)
    dclk = dclk_ns()
    opener = (20 * dclk + 999) // 1000
    pulse = (10 * dclk + 99) // 100
    assert (opener, pulse) == ((4, 20) if dclk == DCLK_NS_16 else (3, 11))
    assert (gclk_byte(2), gclk_byte(3), gclk_byte(5)) == (opener, 40, pulse)


def grammar():
    with pru.Pruss() as p:
        return p.dram(1, UPLOAD_GRAMMAR)


def test_the_register_upload_grammar_defaults_to_the_old_literals(real_pru, fppd):
    """Unset, the upload grammar word is vsync 3, middle burst 11, pre 14
    and a spacer of 8 clocks: 0x080E0B03, what the firmware used to hard
    code.

    Regression: a5cedc5a3.
    """
    icnd(fppd)
    assert grammar() == 0x080E0B03


@pytest.mark.parametrize("clocks,word", [
    # vsync, mid, pre, spacer
    ((5, 0, 9, 0), 0x00090005),    # a skipped middle burst and no spacer
    ((12, 7, 20, 3), 0x0314070C),
])
def test_the_register_upload_grammar_reaches_the_pru(real_pru, fppd, clocks, word):
    """panelRegVsyncClocks / MidClocks / PreClocks / SpacerClocks arrive in
    the word after the chip config, a middle burst of 0 and a spacer of 0
    included (the two values the firmware's loops have to guard).

    Regression: a5cedc5a3.
    """
    vsync, mid, pre, spacer = clocks
    icnd(fppd, panelRegVsyncClocks=vsync, panelRegMidClocks=mid,
         panelRegPreClocks=pre, panelRegSpacerClocks=spacer)
    got = grammar()
    assert got == word, f"upload grammar {got:#010x}, expected {word:#010x}"


def profile(words):
    return {"profile": "scenario", "slot": 3,
            "r": [f"{i:04x}" for i in range(words)],
            "g": [f"{0x100 + i:04x}" for i in range(words)],
            "b": [f"{0x200 + i:04x}" for i in range(words)]}


def test_an_imported_register_profile_replaces_the_built_in_table(real_pru, fppd):
    """A panelRegisters profile in the output config is the one used, whole:
    fppd logs the 22 words per colour it took.

    Regression: 73c2ea54e.
    """
    icnd(fppd, panelRegisters=profile(22))
    assert "using imported register profile 'scenario' (22 words per color)" in fppd.log()


def test_a_truncated_register_profile_is_dropped_whole(real_pru, fppd):
    """Channels of different lengths are refused with a warning, and the
    built-in table is used instead of half the upload.

    Regression: 73c2ea54e.
    """
    bad = profile(22)
    bad["b"] = bad["b"][:10]
    icnd(fppd, panelRegisters=bad)
    log = fppd.log()
    assert "ignoring malformed panelRegisters profile" in log
    assert "using imported register profile" not in log


def test_abc_shift_clocks_the_whole_panel_height(real_pru, fppd):
    """An ABC Shift panel's addressing word carries the mode (3), the scan
    rows and the panel height: the firmware clocks one bit per panel row,
    since a row driver can be daisy chained per band of scan rows. A 64x32
    1/16 panel: 3 | 16 << 8 | 32 << 16.

    Regression: 5388d3b7c (a band lagged by its index in rows when only
    the scan rows were shifted).
    """
    start_panel(fppd, panelRowAddressType=ABC_SHIFT)
    with pru.Pruss() as p:
        word = p.dram(1, ADDR_CONFIG)
    assert word == ABC_SHIFT | (16 << 8) | (32 << 16), f"addressing word {word:#010x}"
