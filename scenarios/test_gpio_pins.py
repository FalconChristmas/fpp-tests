"""GPIO inputs and outputs on real header lines (gpio.json, /api/gpio, the
GPIO command).

Device only: run with run-local.sh on a Raspberry Pi, which passes the
gpiochips through. The pins used are P1-37 (GPIO26) and P1-31 (GPIO6), left
unconnected on a bare board; check that nothing on the device uses them.
Skipped where the pins don't exist.
"""

import os
import urllib.error

import pytest

INPUT_PIN = "P1-37"


def have_pin(fppd, pin):
    if not any(p.get("pin") == pin for p in fppd.get("/gpio") or []):
        pytest.skip(f"no GPIO pin {pin} on this board")


def test_a_configured_input_is_not_driven(fppd):
    """A pin gpio.json configures as an input refuses to be driven by
    POST /api/gpio/<pin> (409) and by the GPIO command (an error), and stays
    an input.

    Regression: 061853501. Both reconfigured the pin as an output: the
    input's edge-event request was released and the fd the main loop watches
    was closed, so the input went dead until fppd restarted.
    """
    fppd.write("config/gpio.json", [{"pin": INPUT_PIN, "enabled": True, "mode": "gpio",
                                     "rising": {"command": "Set Variable", "args": ["X", "1"]}}])
    fppd.start()
    have_pin(fppd, INPUT_PIN)
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post(f"/gpio/{INPUT_PIN}", {"value": 1})
    assert e.value.code == 409, e.value.body
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.command("GPIO", INPUT_PIN, "true")
    assert "configured as a GPIO input" in e.value.body, e.value.body


OUTPUT_PIN = "P1-31"


class GpioTrace:
    """The kernel's gpio tracepoints (gpio_direction, gpio_value), read
    through a private tracefs mount. They are global: enabled for the
    duration of a test and restored after."""

    def __init__(self):
        import subprocess
        import tempfile
        self.dir = tempfile.mkdtemp(prefix="tracefs-")
        r = subprocess.run(["mount", "-t", "tracefs", "nodev", self.dir], capture_output=True)
        if r.returncode or not os.path.exists(self.path("events/gpio/enable")):
            pytest.skip("no gpio tracepoints here")
        self.was = open(self.path("events/gpio/enable")).read().strip()

    def path(self, rel):
        return os.path.join(self.dir, rel)

    def start(self):
        with open(self.path("trace"), "w") as f:
            f.write("")
        with open(self.path("events/gpio/enable"), "w") as f:
            f.write("1")

    def events(self):
        with open(self.path("trace")) as f:
            return [l for l in f if "gpio_value:" in l or "gpio_direction:" in l]

    def close(self):
        import subprocess
        try:
            with open(self.path("events/gpio/enable"), "w") as f:
                f.write("0" if self.was in ("0", "X") else "1")
        finally:
            subprocess.run(["umount", self.dir])


def test_driving_an_output_again_does_not_glitch_it(fppd):
    """Setting an output that is already on to on again leaves it on: the
    line is not driven low in between.

    Regression: 6d8f1bcd9. With libgpiod v2, configPin() released and
    re-requested the line on every call, and a new output request starts
    inactive, so a relay that was on dropped out until setValue().
    """
    fppd.start()
    have_pin(fppd, OUTPUT_PIN)
    trace = GpioTrace()
    try:
        trace.start()
        fppd.post(f"/gpio/{OUTPUT_PIN}", {"value": 1})
        fppd.post(f"/gpio/{OUTPUT_PIN}", {"value": 1})
        fppd.post(f"/gpio/{OUTPUT_PIN}", {"value": 1})
        events = trace.events()
    finally:
        trace.close()
    ones = [l for l in events if "gpio_value:" in l and l.rstrip().endswith("set 1")]
    assert ones, events
    gpio = ones[0].split("gpio_value:")[1].split()[0]
    mine = [l.split("gpio_value:")[1].split() for l in events
            if "gpio_value:" in l and l.split("gpio_value:")[1].split()[0] == gpio]
    first_on = next(i for i, e in enumerate(mine) if e[-1] == "1")
    assert all(e[-1] == "1" for e in mine[first_on:]), mine
