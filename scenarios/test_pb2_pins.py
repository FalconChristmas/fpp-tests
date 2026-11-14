"""The PocketBeagle 2's pin table in fppd (util/BBBUtils.cpp): which header
pin an output muxes for what it opens.

Device only: run with run-local.sh on a PocketBeagle 2, whose stub pinctrl
logs the mux requests without touching a pad (hosttools.py). Skipped
elsewhere.
"""

import os
import re
import subprocess

import pytest

import hosttools
from test_conditions import set_variable

DEBUG_GPIO = "/sys/kernel/debug/gpio"


def pocketbeagle2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


def test_a_serial_output_on_ttys6_muxes_uart2s_transmit_pin(fppd):
    """A GenericSerial output on /dev/ttyS6 muxes P2-04 to its UART: on the
    PocketBeagle 2 ttyS6 is the device tree's alias for UART2, whose
    transmit is on P2-04.

    Regression: 661545976 (fppd's table; the pinctrl half is built into
    the image). The table named the UARTs by TI's numbers, so ttyS6 was
    taken for UART6 and P1-12 was muxed -- the console's transmit line --
    while the data went out of UART2 on a pin nobody had muxed.
    """
    if not pocketbeagle2():
        pytest.skip("needs a PocketBeagle 2 under run-local.sh")
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's stub pinctrl")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "device": "ttyS6", "speed": 115200, "header": "", "footer": ""}]})
    calls = hosttools.pinctrl_calls()
    fppd.start(timeout=60)
    muxed = [c for c in calls.calls() if c.endswith(" uart")]
    assert "-s P2_04 uart" in muxed, calls.calls()
    assert not any("P1_12" in c for c in muxed), calls.calls()


def gpio0_line(line):
    """What gpiolib's debugfs says of a line of 600000.gpio (GPIO0): its
    consumer, direction and level, or None while nothing holds it."""
    if not os.path.exists(DEBUG_GPIO):
        subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"], check=False)
    try:
        with open(DEBUG_GPIO) as f:
            text = f.read()
    except OSError:
        pytest.skip("no gpio debugfs")
    chip = re.search(r"^gpiochip\d+: .*600000\.gpio.*$((?:\n .*)*)", text, re.M)
    if not chip:
        pytest.skip("no 600000.gpio in gpio debugfs")
    m = re.search(r"^ gpio-%d\s+\([^|)]*\|([^)]*)\)\s+(in|out)\s+(hi|lo)" % line, chip.group(1), re.M)
    return None if not m else (m.group(1).strip(), m.group(2), m.group(3))


def test_the_boot_button_is_a_gpio_input_fppd_never_remuxes(fppd):
    """A gpio.json input on the pin named "BOOT" -- the PocketBeagle 2's
    BOOT button, GPIO0_28 -- starts: /api/gpio lists the pin as chip 2
    line 28, fppd holds that line of 600000.gpio as an input reading low
    (the button's idle level), and choosing a pull-up mode for it sends
    pinctrl nothing, so the pad stays as the bootmode resistors set it.

    Feature: 86058f887 (fppd's table; the pinctrl half is built into the
    image). There was no BOOT pin, so the button could not trigger
    anything.
    """
    if not pocketbeagle2():
        pytest.skip("needs a PocketBeagle 2 under run-local.sh")
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's stub pinctrl")
    if gpio0_line(28) is not None:
        pytest.skip(f"GPIO0_28 is held already: {gpio0_line(28)}")
    fppd.write("config/gpio.json", [{
        "pin": "BOOT", "enabled": True, "mode": "gpio_pu", "desc": "boot button",
        "rising": [set_variable("BootPressed", "1")], "falling": [], "holdTime": 0, "hold": []}])
    calls = hosttools.pinctrl_calls()
    fppd.start(timeout=60)
    boot = [p for p in fppd.get("/gpio") or [] if p.get("pin") == "BOOT"]
    assert boot, [p.get("pin") for p in fppd.get("/gpio") or []]
    assert (boot[0].get("gpioChip"), boot[0].get("gpioLine")) == (2, 28), boot
    held = gpio0_line(28)
    assert held and held[1:] == ("in", "lo"), held
    assert not any("BOOT" in c or "T24" in c for c in calls.calls()), calls.calls()
