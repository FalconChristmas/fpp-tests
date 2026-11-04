"""A BBShiftPanel cape as it is on the device: its real EEPROM, signed, so
every output is licensed and panels on the outputs past the first are
driven. Panel test box only (a PocketBeagle2 with a PocketScroller cape and
panels), under run-local.sh --host-pru --host-i2c --host-pinctrl; skipped
elsewhere.

The unsigned cape the other scenarios run on licenses output 1 only, and
BBShiftPanelOutput::Init() drops a panel on any other output (silently:
its channels are then mapped to nothing).
"""

import time

import pytest

import pru
from pru import real_cape, real_pru  # noqa: F401 (fixtures)
from test_am62x_panels import matrix, needs_16_outputs, needs_panel_config, panels_config  # noqa: F401

PANEL_CHANNELS = 64 * 32 * 3  # one 64x32 panel


def bits_high(fppd, channels, color, samples=600):
    """The bits of PRU1's output register seen high over `samples` halts
    with `channels` (a range, "1-6144") lit `color`."""
    fppd.command("Test Start", "1000", "RGB Single Color", channels, color)
    time.sleep(4)
    seen = 0
    with pru.Pruss() as p:
        for _ in range(samples):
            assert p.halt(1), "PRU1 did not halt"
            seen |= p.register(1, 30)
            assert p.resume(1), "PRU1 did not stay running"
            time.sleep(0.002)
    fppd.command("Test Stop")
    return seen


def test_a_panel_on_the_second_output_is_driven_on_a_signed_cape(real_cape, fppd):
    """A matrix of two panels, one on cape output 1 and one on output 2:
    with only the first lit, the data pins of the first output go high, and
    with only the second lit, pins the first did not, so the second output
    has its own data lines driven, not left dark.

    The data pins are what rises over a black frame (the clock, latch, row
    and OE lines move either way), so no pin map is needed: each output
    must have a data bit the other has not.

    Feature: the licensed outputs of a signed cape. Unsigned, the second
    panel is dropped in Init() (red with that put back: the second output
    lights nothing).
    """
    fppd.write("config/channeloutputs.json", panels_config(matrix(1, (0, 1))))
    fppd.start(timeout=90)
    needs_panel_config(fppd)
    assert "are not mapped to any panel" not in fppd.log(), fppd.tail()
    both = "1-%d" % (2 * PANEL_CHANNELS)
    dark = bits_high(fppd, both, "#000000", samples=1000)
    first = bits_high(fppd, "1-%d" % PANEL_CHANNELS, "#FFFFFF") & ~dark
    second = bits_high(fppd, "%d-%d" % (PANEL_CHANNELS + 1, 2 * PANEL_CHANNELS), "#FFFFFF") & ~dark
    assert first, f"nothing rose over a black frame with the first panel lit (dark {dark:#x})"
    assert first & ~second, f"the first output's data bits {first:#x} are all in the second's {second:#x}"
    assert second & ~first, f"the second panel drove no data pin of its own: first {first:#x}, second {second:#x}"
