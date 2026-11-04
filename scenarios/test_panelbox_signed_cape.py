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
from test_am62x_panels import matrix, needs_panel_config, panels_config, save_outputs, warnings_of

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


def started(fppd):
    return fppd.log().count("Init succeeded, adding to channel outputs")


def driven(fppd, dark):
    """The data bits each of the cape's first two outputs drives, lit in
    turn (channels of the panel on each), over a black frame's."""
    first = bits_high(fppd, "1-%d" % PANEL_CHANNELS, "#FFFFFF") & ~dark
    second = bits_high(fppd, "%d-%d" % (PANEL_CHANNELS + 1, 2 * PANEL_CHANNELS), "#FFFFFF") & ~dark
    return first, second


def test_two_matrices_on_two_outputs_each_drive_their_own_output(real_cape, fppd):
    """Two matrices on one cape, one panel each on outputs 1 and 2: both
    start, and each lights its own output. Taking the second matrix out of
    the config (a reload with the output running) leaves the first one
    refreshing and the second output dark, and putting it back lights it
    again.

    Feature: bd5dcc2fe. The cape could carry only one matrix: a second was
    a second owner of the same PRUs, whatever its shape. Red with the second
    refused: its output stays dark. (Unsigned, the second matrix has no
    licensed panel; the FAKE_PRU scenarios check the frame shape rules.)
    """
    one = matrix(1, (0,))
    two = matrix(PANEL_CHANNELS + 1, (1,))
    fppd.write("config/channeloutputs.json", panels_config(one, two))
    fppd.start(timeout=90)
    needs_panel_config(fppd)
    assert started(fppd) == 2, (warnings_of(fppd), fppd.tail())
    assert not [w for w in warnings_of(fppd) if "LED panel" in w], warnings_of(fppd)
    dark = bits_high(fppd, "1-%d" % (2 * PANEL_CHANNELS), "#000000", samples=1000)
    first, second = driven(fppd, dark)
    assert first and second, f"an output is dark: first {first:#x}, second {second:#x}"
    assert first & ~second and second & ~first, f"the outputs share their data bits: {first:#x}, {second:#x}"

    n = started(fppd)
    save_outputs(fppd, panels_config(one))
    fppd.wait_for(lambda: started(fppd) > n, timeout=60, what="the reload without the second matrix")
    time.sleep(3)
    first_again, second_gone = driven(fppd, dark)
    assert first_again & first, f"the first matrix stopped refreshing: {first_again:#x}"
    assert not second_gone & second & ~first, f"the second output is still driven: {second_gone:#x}"

    n = started(fppd)
    save_outputs(fppd, panels_config(one, two))
    fppd.wait_for(lambda: started(fppd) >= n + 2, timeout=60, what="the reload with both matrices")
    time.sleep(3)
    first_back, second_back = driven(fppd, dark)
    assert first_back & first and second_back & second & ~first, f"{first_back:#x}, {second_back:#x}"
