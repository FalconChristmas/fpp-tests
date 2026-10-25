"""Raspberry Pi header lines as fppd requests and releases them through
libgpiod: open-drain (gpio_od) lines for a plugin's bit-banged bus, and a
GPIO channel output's line once the output is gone.

The kernel's view is the oracle: gpioinfo for the request fppd holds (its
direction, drive, bias and consumer) and the real pinctrl for the pad.
Device only: run with run-local.sh on a Pi; the pins are plain header
GPIOs no one holds (test_pi_gpio_inputs.PINS), put back after each
scenario.
"""

import json
import os
import subprocess
import time

import pytest

import hosttools
import shims
from native_plugin import install
from test_gpio_pins import PLAIN_PINS, free_pins
from test_pi_gpio_inputs import PINS, as_expander, header_chip, line_info, lines_kept, on_pi

pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header pins")


@pytest.fixture
def pads():
    """The plain pins' pads and lines put back as they were after fppd
    stops (test_pi_gpio_inputs.lines_kept). Ask for it before `fppd`."""
    with lines_kept([PLAIN_PINS[p] for p in PINS]):
        yield


def free_pin():
    free = [p for p in PINS if p in free_pins()]
    if not free:
        pytest.skip("no free plain header GPIO here")
    return free[0]


def pad(gpio):
    """The pad's function and pull as the real pinctrl reads them, and its
    level: ("ip", "pu", "hi")."""
    out = subprocess.run([hosttools.real("pinctrl"), "get", str(gpio)], capture_output=True,
                         text=True).stdout
    words = out.split("//")[0].split(":", 1)[-1].replace("|", " ").split()
    func = words[0]
    pull = next((w for w in words if w in ("pu", "pd", "pn")), None)
    level = next((w for w in words if w in ("hi", "lo")), None)
    return func, pull, level


def drive(fppd, pin, mode, value=""):
    return fppd.command("Native Test GPIO", pin, mode, value)


def test_an_open_drain_line_drives_low_and_releases_to_its_pull_up(pads, fppd):
    """A plugin's gpio_od line: the kernel holds it as an open-drain output
    with the pull-up bias; set to 0 the pad drives low, set to 1 the pad
    stops driving and the pull-up takes the line high, which getValue()
    reads back -- no direction change asked for.

    Regression: f3adfcbe5 (gpio_od added for bit-banged buses). Shown red on
    master with a hand patch treating gpio_od as a plain output: the line
    was push-pull, and released, it drove high instead of letting go.
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    install(fppd, features=["NATIVE_GPIO"])
    fppd.start()
    assert drive(fppd, pin, "gpio_od", "0") == "acquired 1 value 0"
    info = line_info(gpio)
    assert "output" in info and "drive=open-drain" in info and "bias=pull-up" in info, info
    assert pad(gpio)[0] == "op" and pad(gpio)[2] == "lo", pad(gpio)
    assert drive(fppd, pin, "gpio_od", "1") == "acquired 1 value 1"
    assert pad(gpio) == ("ip", "pu", "hi"), f"released: {pad(gpio)}, {line_info(gpio)}"
    assert drive(fppd, pin, "gpio_od", "0") == "acquired 1 value 0"


def test_an_open_drain_line_on_a_chip_without_pulls_is_still_requested(pads, fppd):
    """A gpio_od line whose chip refuses a bias (gpiorefuse.c makes the
    kernel answer a request with a bias as an expander's driver does:
    EINVAL) is requested again without one: the plugin gets an open-drain
    line it can drive, with no warning raised.

    Regression: a34a18a00. The pull-up was part of the one request: refused,
    the line was never acquired and "Could not configure pin ... as
    gpio_od" was raised.
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    install(fppd, features=["NATIVE_GPIO"])
    fppd.start(preload=[shims.build("gpiorefuse.c")],
               extra_env={"GPIOREFUSE": "bias", "GPIOREFUSE_LINE": str(gpio)})
    assert drive(fppd, pin, "gpio_od", "0") == "acquired 1 value 0"
    info = line_info(gpio)
    assert "drive=open-drain" in info and "bias=" not in info, info
    warnings = [w for w in fppd.get("/fppd/warnings") if "Could not configure pin" in str(w)]
    assert not warnings, warnings
    assert "open-drain configured without an internal pull-up" in fppd.log()


def test_a_gpio_outputs_line_is_released_when_the_output_goes(pads, fppd):
    """A GPIO channel output holds its line (gpioinfo names fppd's request
    as the consumer); saved away from the Other outputs, the output is
    closed and the line is let go.

    Regression: 0d7983f33. Outputs never released the GPIO lines they
    requested: with libgpiod (trixie) the line stayed held by fppd until it
    exited, so nothing else could use it.
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    path = os.path.join(fppd.media, "config", "co-other.json")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GPIO", "enabled": 1, "startChannel": 1, "channelCount": 1, "pin": pin}]})
    fppd.start()
    fppd.wait_for(lambda: "consumer=" in line_info(gpio), timeout=5, what="the output's line request")
    assert "output" in line_info(gpio), line_info(gpio)
    with open(path + ".new", "w") as f:
        json.dump({"channelOutputs": []}, f)
    os.replace(path + ".new", path)
    try:
        fppd.wait_for(lambda: "consumer=" not in line_info(gpio), timeout=10,
                      what="the line to be released")
    except TimeoutError:
        pytest.fail(f"the output is gone and fppd still holds the line: {line_info(gpio)}")


def test_the_i2c_pins_go_back_to_i2c_when_let_go(fppd):
    """A GPIO output configured on P1-3 (GPIO2, i2c1 SDA, held by the kernel
    for the bus here, so never actually driven) puts the pad back to the
    function the kernel has it on (pinctrl's "a0" on a Pi 3/4, "a3" on a
    Pi 5) when the output goes: fppd's pinctrl call -- to run-local.sh's stub, which only
    logs it -- matches the real pinctrl's reading of the pad.

    Regression: 57dc41c5e (the i2c half). P1-3 and P1-5 were reset to "a3",
    the Pi 5's i2c function, on every Pi: on a Pi 3/4 that is not i2c, and
    releasing the pin took the bus off the header. (So only a Pi 3/4 goes
    red; a Pi 5 checks its own reset is right.)
    """
    if 'consumer="kernel"' not in line_info(2):
        pytest.skip("needs a Pi whose kernel holds GPIO2 for i2c1 (so fppd can't take it)")
    real = pad(2)[0]
    path = os.path.join(fppd.media, "config", "co-other.json")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GPIO", "enabled": 1, "startChannel": 1, "channelCount": 1, "pin": "P1-3"}]})
    calls = hosttools.pinctrl_calls()
    fppd.start()
    with open(path + ".new", "w") as f:
        json.dump({"channelOutputs": []}, f)
    os.replace(path + ".new", path)
    resets = lambda: [c for c in calls.calls() if c.split()[:2] == ["set", "2"] and c.split()[-1][0] == "a"]
    try:
        fppd.wait_for(resets, timeout=10, what="P1-3 reset")
    except TimeoutError:
        pytest.fail(f"no reset of GPIO2 to an alt function; pinctrl calls: {calls.calls()}")
    assert resets()[-1] == f"set 2 {real}", (resets(), f"the pad is on {real}")
    assert 'consumer="kernel"' in line_info(2), line_info(2)


def chip_of_line_names():
    """{line name: chip number} for every line name gpioinfo lists once."""
    out = subprocess.run(["gpioinfo"], capture_output=True, text=True).stdout
    chips, chip = {}, None
    for line in out.splitlines():
        if line.startswith("gpiochip"):
            chip = int(line.split()[0][8:])
        elif '"' in line and chip is not None:
            chips.setdefault(line.split('"')[1], set()).add(chip)
    return {n: c.pop() for n, c in chips.items() if len(c) == 1}


def test_api_gpio_puts_each_line_on_its_own_chip(fppd):
    """/api/gpio lists each line of a gpiochip fpp scans (here the header's,
    found by label and relabelled by gpioexpander.c as an expander so the
    scan doesn't skip it) with the number of the gpiochip it is on, as gpioinfo has it --
    whatever order /dev lists the chips in.

    Regression: 57dc41c5e (the enumeration half). Chips were numbered in
    the order the /dev directory listed them, which isn't their number:
    where /dev lists gpiochip1 before gpiochip0 (as on a Pi 4 here), the
    lines of gpiochip0 were put on chip 1, so a GPIO looked up by chip and
    line got another chip's line. Only shows where the header chip's place
    in /dev's listing isn't its number.
    """
    c = header_chip()[0]
    listed = [n for n in os.listdir("/dev") if n.startswith("gpiochip")]
    if listed.index(f"gpiochip{c}") == c:
        pytest.skip(f"/dev lists gpiochip{c} at position {c}, so the old numbering came out right")
    fppd.start(preload=[shims.build("gpioexpander.c")], extra_env=as_expander())
    want = chip_of_line_names()
    got = {p["pin"]: p.get("gpioChip") for p in fppd.get("/gpio") or [] if "pin" in p}
    checked = {n: got[n] for n in want if n in got}
    if len(checked) < 2:
        pytest.skip(f"/api/gpio names too few gpiochip lines here: {sorted(got)[:10]}")
    wrong = {n: (c, want[n]) for n, c in checked.items() if c != want[n]}
    assert not wrong, f"(listed chip, real chip): {dict(list(wrong.items())[:5])}"
