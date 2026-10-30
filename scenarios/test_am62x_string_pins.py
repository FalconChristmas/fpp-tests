"""The header pins a BBShiftString output takes on a PocketBeagle2: which
pads it asks pinctrl to hand to the PRU, and what it calls itself on the GPIO
lines it holds (the consumer gpioinfo shows). Against PRUs that never answer
(see bbcape.py); run-local.sh's stub pinctrl logs the mux requests, and the
line consumers are read back from gpiolib's debugfs.

Device only: run with run-local.sh on a PocketBeagle2. Stop the device's own
fppd first: it holds the string pins. Skipped elsewhere.
"""

import os
import re
import subprocess

import pytest

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape
from test_bb_strings import pinctrl_calls, pinctrl_mark

DEBUG_GPIO = "/sys/kernel/debug/gpio"

# PRU1's default data pins (pin 0..7) and its clock and latch on a PocketBeagle2
DATA_PINS = ["P2-02", "P2-04", "P2-06", "P2-08", "P2-20", "P1-20", "P2-24", "P2-33"]
CTRL_PINS = ["P2-17", "P2-18"]


def gpio_debugfs():
    if not os.path.exists(DEBUG_GPIO):
        subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"], check=False)
    try:
        with open(DEBUG_GPIO) as f:
            return f.read()
    except OSError:
        pytest.skip("no gpio debugfs")


def consumer(text, pin):
    """Who holds header pin `pin` ("P2-02", the line named "P2.02" or
    "P2.02/AIN6"), from a debugfs listing; None if nothing does."""
    m = re.search(r"\(" + re.escape(pin.replace("-", ".")) + r"(?:[/(][^\s|]*)?\s*\|([^)]*)\)", text)
    return m.group(1).strip() if m else None


def one_string_cape(fppd, name):
    """16 shift register outputs on PRU1's first two data pins, and a
    string on output 1 only (data pin 0)."""
    fake_pru(fppd)
    held = [p for p in DATA_PINS + CTRL_PINS if consumer(gpio_debugfs(), p)]
    if held:
        pytest.skip(f"{held} are held: stop the device's own fppd first")
    outs = [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]
    write_string_cape(name, {"driver": "BBShiftString", "outputs": outs})
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", name, [pixel_output(0, 10, 0)]))


def test_only_the_data_pins_with_strings_are_muxed_to_the_pru(fppd):
    """With a string on one data pin only, fppd hands that pin and PRU1's
    clock and latch to the PRU, and leaves the other seven data pins to
    whatever else wants them.

    Regression: d934bfb7d. Every data pin of a PRU with any string was
    muxed to pru1out, so a smaller cape couldn't reuse the pins it has no
    strings on.
    """
    one_string_cape(fppd, "TestOnePin")
    mark = pinctrl_mark()
    fppd.start(timeout=60)
    calls = pinctrl_calls(mark)
    muxed = sorted({c.split()[1].replace("_", "-") for c in calls
                    if c.startswith("-s ") and c.endswith(" pru1out")})
    assert muxed == sorted(["P2-02"] + CTRL_PINS), calls


def test_the_string_pins_say_who_holds_them(fppd):
    """The GPIO lines a BBShiftString output takes for its data, clock and
    latch pins carry "FPPD-BBShiftString" as their consumer, so gpioinfo
    tells them apart from fppd's other lines.

    Regression: 9a1a43552. Every line fppd requested was "FPPD": there was
    no way to pass configPin() a description of what the pin is for.
    """
    one_string_cape(fppd, "TestPinNames")
    fppd.start(timeout=60)
    text = gpio_debugfs()
    held = {p: consumer(text, p) for p in ["P2-02"] + CTRL_PINS}
    assert held == {p: "FPPD-BBShiftString" for p in held}, held
