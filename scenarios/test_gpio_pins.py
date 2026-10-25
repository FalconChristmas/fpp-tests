"""GPIO inputs and outputs on real header lines (gpio.json, /api/gpio, the
GPIO command).

Device only: run with run-local.sh on a Raspberry Pi, which passes the
gpiochips through. The pins used are plain header GPIOs that are inputs no
one holds (gpioinfo shows no consumer): on a cape with an OLED and buttons
the device's own fppoled holds some, and an output something set up without
holding the line may be wired to hardware. Skipped where there are none.
"""

import os
import subprocess
import urllib.error

import pytest

import hosttools

# Header pins that are plain GPIOs on every 40-pin Pi (no default alt
# function), in order of preference: pin -> GPIO number.
PLAIN_PINS = {"P1-37": 26, "P1-31": 6, "P1-36": 16, "P1-16": 23, "P1-7": 4, "P1-11": 17,
              "P1-13": 27, "P1-29": 5, "P1-15": 22, "P1-18": 24, "P1-22": 25}


def free_pins():
    """PLAIN_PINS whose line is an input with no consumer, in order."""
    try:
        out = subprocess.run(["gpioinfo"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return []
    lines = {}
    for line in out.splitlines():
        for pin, gpio in PLAIN_PINS.items():
            if f'"GPIO{gpio}"' in line:
                lines[pin] = line
    return [pin for pin in PLAIN_PINS if pin in lines and "consumer=" not in lines[pin]
            and "[used]" not in lines[pin] and "output" not in lines[pin]]


def free_pin():
    """The first free plain header pin, or skip. Ask before fppd starts:
    once it holds the pin, the pin isn't free any more."""
    pins = free_pins()
    if not pins:
        pytest.skip("no free plain header GPIO here: no board pins, or all held or driven")
    return pins[0]


@pytest.fixture
def pads():
    """The pads these scenarios can reach, put back as they were after
    fppd stops (hosttools.pads_kept): a line fppd drove stays an output
    when it lets go. Ask for it before `fppd`."""
    with hosttools.pads_kept(PLAIN_PINS.values()):
        yield


def have_pin(fppd, pin):
    if not any(p.get("pin") == pin for p in fppd.get("/gpio") or []):
        pytest.skip(f"no GPIO pin {pin} on this board")


def pull(gpio):
    """"pu", "pd" or "pn": the pad's pull as the real pinctrl reads it."""
    state = hosttools.pad_states([gpio])[gpio] or ""
    return next((w for w in state.split() if w in ("pu", "pd", "pn")), None)


def test_an_inputs_pull_reaches_the_pad(pads, fppd):
    """A gpio.json input in gpio_pu or gpio_pd mode, with edge actions,
    comes up with that pull on the pad, read back with the real pinctrl --
    for a pin of each kind fpp's Pi pin table has: P1-7, which keeps the
    table's default reset mode ("a0"); P1-11, reset to "ip" ("no" on a
    Pi 5); P1-37, reset to "ip" everywhere. Each asks for the pull its pad
    isn't at now, so the check can fail.

    Regression: f5ded7082 (on a pin whose reset mode was still the default
    "a0", configPin took a pinctrl-only shortcut and returned, so the pull
    was never asked for) and d0a4e12ba (on a Pi 5 the "no" reset mode took
    the same shortcut: P1-35 and P1-11's kind came up floating). Since
    fa30658a0 the shortcut no longer returns, which on its own also keeps
    the pull; each fix was shown red on a device against master with the
    shortcut put back as it was at the fix's parent.

    Not bae7ebf18 (the edge-event request carrying configPin's bias): with
    it undone on master the pads keep their pull all the same.
    """
    want = {}
    for pin in ("P1-7", "P1-11", "P1-37"):
        if pin in free_pins():
            gpio = PLAIN_PINS[pin]
            want[pin] = (gpio, "pd" if pull(gpio) == "pu" else "pu")
    if not want:
        pytest.skip("none of P1-7, P1-11 and P1-37 is free here")
    fppd.write("config/gpio.json", [
        {"pin": pin, "enabled": True, "mode": "gpio_" + p,
         "rising": {"command": "Set Variable", "args": ["X", "1"]},
         "falling": {"command": "Set Variable", "args": ["X", "0"]}}
        for pin, (gpio, p) in want.items()])
    fppd.start()
    expected = {pin: p for pin, (gpio, p) in want.items()}
    got = lambda: {pin: pull(gpio) for pin, (gpio, p) in want.items()}
    try:
        fppd.wait_for(lambda: got() == expected, timeout=5, what="the pulls")
    except TimeoutError:
        pytest.fail(f"asked for {expected}, the pads have {got()}\n{fppd.log()[-3000:]}")


def test_a_configured_input_is_not_driven(pads, fppd):
    """A pin gpio.json configures as an input refuses to be driven by
    POST /api/gpio/<pin> (409) and by the GPIO command (an error), and stays
    an input.

    Regression: 061853501. Both reconfigured the pin as an output: the
    input's edge-event request was released and the fd the main loop watches
    was closed, so the input went dead until fppd restarted.
    """
    pin = free_pin()
    fppd.write("config/gpio.json", [{"pin": pin, "enabled": True, "mode": "gpio",
                                     "rising": {"command": "Set Variable", "args": ["X", "1"]}}])
    fppd.start()
    have_pin(fppd, pin)
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post(f"/gpio/{pin}", {"value": 1})
    assert e.value.code == 409, e.value.body
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.command("GPIO", pin, "true")
    assert "configured as a GPIO input" in e.value.body, e.value.body


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


def test_driving_an_output_again_does_not_glitch_it(pads, fppd):
    """Setting an output that is already on to on again leaves it on: the
    line is not driven low in between.

    Regression: 6d8f1bcd9. With libgpiod v2, configPin() released and
    re-requested the line on every call, and a new output request starts
    inactive, so a relay that was on dropped out until setValue().
    """
    pin = free_pin()
    fppd.start()
    have_pin(fppd, pin)
    trace = GpioTrace()
    try:
        trace.start()
        fppd.post(f"/gpio/{pin}", {"value": 1})
        fppd.post(f"/gpio/{pin}", {"value": 1})
        fppd.post(f"/gpio/{pin}", {"value": 1})
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
