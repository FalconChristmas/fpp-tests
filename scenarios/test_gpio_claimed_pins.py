"""Raspberry Pi header pins that are not plain free GPIOs: a pin a kernel
driver holds (strict pinmux, kernel 6.18), a uart pad left at its alt
function, and a PWM pin whose PWM chip can't be set up.

Device only: run with run-local.sh on a Raspberry Pi. run-local.sh passes the
gpiochips through and gives fppd a pinctrl stub that only logs (the real one
writes the pad registers directly): nothing here re-muxes a pad. /sys is
read-only there, so fppd can neither
unbind a driver nor export a PWM channel. The pads a scenario reaches are
read before it and put back after it (a released gpiod line stays muxed as a
GPIO). The kernel's gpio consumer
(gpioinfo) is the oracle for whether fppd holds a line; pinctrl's view isn't.
Skipped where the pins aren't as described (each scenario checks first).
"""

import glob
import os
import re
import subprocess
import time
import urllib.error

import pytest

import hosttools


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header pins")


HEADER_GPIOS = (2, 3, 12, 13, 15, 18, 19, 27)  # every pad a scenario here can reach


@pytest.fixture
def pads():
    """The header pads as they were before the scenario, put back after it
    (hosttools.pads_kept). Ask for it first, so it runs after fppd has
    stopped."""
    with hosttools.pads_kept(HEADER_GPIOS):
        yield


@pytest.fixture
def pinctrl():
    """What fppd asks run-local.sh's pinctrl stub to do during the scenario
    (a hosttools.CallLog). Skips where fppd has the real pinctrl."""
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (not --host-pinctrl)")
    hosttools.real("pinctrl")
    return hosttools.pinctrl_calls()


@pytest.fixture
def debugfs():
    """debugfs at /sys/kernel/debug, where fppd looks up which device holds
    a pin. run-local.sh's read-only /sys is a bind without submounts, so it
    is mounted again here. Not with "ro": debugfs is one superblock, and a
    read-only mount of it would make the device's own read-only too."""
    if os.path.isdir("/sys/kernel/debug/pinctrl"):
        yield
        return
    r = subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"],
                       capture_output=True, text=True)
    if r.returncode:
        pytest.skip("cannot mount debugfs here: " + r.stderr.strip())
    try:
        yield
    finally:
        subprocess.run(["umount", "/sys/kernel/debug"])


def pinmux_owner(gpio):
    """(device, function) holding a header pin's mux, '' for UNCLAIMED, or
    None if the pin controller says nothing about it."""
    for d in glob.glob("/sys/kernel/debug/pinctrl/*"):
        if not re.search(r"-pinctrl-(rp1|bcm2711|bcm2835)$", d):
            continue
        with open(os.path.join(d, "pinmux-pins")) as f:
            for line in f:
                if line.startswith(f"pin {gpio} ("):
                    m = re.search(r"\): device (\S+) function (\S+)", line)
                    return (m.group(1), m.group(2)) if m else ""
    return None


def bound_children(device):
    """Drivers bound below a platform device, other than its own."""
    top = os.path.join("/sys/bus/platform/devices", device)
    out = set()
    for root, dirs, files in os.walk(top, followlinks=False):
        if root.count(os.sep) - top.count(os.sep) >= 5:
            dirs[:] = []
        link = os.path.join(root, "driver")
        if root != top and os.path.islink(link):
            out.add(os.path.basename(os.readlink(link)))
    return out


def line_info(gpio):
    """gpioinfo's line for header GPIO `gpio` (named GPIO<n>)."""
    r = subprocess.run(["gpioinfo"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if f'"GPIO{gpio}"' in line:
            return line
    pytest.skip(f"gpioinfo has no line GPIO{gpio}")


def free_line(gpio):
    info = line_info(gpio)
    if "consumer=" in info or "[used]" in info:
        pytest.skip(f"GPIO{gpio} is in use on this device: {info.strip()}")
    return info


def i2c1_owner():
    """GPIO2's mux owner and the drivers bound on it, or skip: the
    scenarios below need a pin a kernel driver holds (strict pinmux) on a
    bus something is using, so that fppd refuses rather than unbinds."""
    owner = pinmux_owner(2)
    if not owner:
        pytest.skip(f"GPIO2 is not held by a kernel driver here (strict pinmux): {owner!r}")
    device, function = owner
    children = bound_children(device) - {"spidev"}
    if not children:
        pytest.skip(f"nothing is bound on {device}; fppd would try to unbind it")
    return device, function, children


def test_a_pin_a_kernel_driver_holds_is_not_reported_driven(pads, pinctrl, debugfs, fppd):
    """A header pin that i2c1 holds is refused: POST /api/gpio/<pin>
    answers 409 and caches nothing, the GPIO command fails, and an input on
    its partner pin is left out with a log line. The pin stays the
    kernel's.

    Regression: a988c3ad3. The line request failed quietly and every caller
    went on as though it hadn't: the API answered 200 "set successfully"
    and a GET echoed the cached 1, and the input was polled on a value
    that could never change.
    """
    i2c1_owner()
    fppd.write("config/gpio.json", [{"pin": "P1-5", "enabled": True, "mode": "gpio_pu",
                                     "falling": {"command": "Set Variable", "args": ["X", "1"]}}])
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post("/gpio/P1-3", {"value": 1})
    assert e.value.code == 409 and "could not be acquired" in e.value.body, e.value.body
    try:
        got = fppd.get("/gpio/P1-3")
    except urllib.error.HTTPError as e:
        got = e.body
    assert not (isinstance(got, dict) and got.get("value") == 1), got
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.command("GPIO", "P1-3", "true")
    assert "could not be acquired" in e.value.body, e.value.body
    assert "GPIO Input P1-5: the line could not be acquired" in fppd.log(), fppd.tail()
    assert 'consumer="kernel"' in line_info(2), line_info(2)


def test_a_pin_on_a_bus_in_use_names_the_driver_to_disable(pads, pinctrl, debugfs, fppd):
    """Asking for a pin i2c1 holds, while devices are bound on that bus,
    raises a warning that names the bound driver and the config.txt
    function to disable, and leaves the controller's driver bound.

    Feature: 475776dcd (its refusal; unbinding a driver to free a pin needs
    a writable /sys and a bus nothing uses). Before it, fppd never looked
    at who held the pin, and nothing said which driver to disable.
    """
    device, function, children = i2c1_owner()
    fppd.start()
    try:
        fppd.post("/gpio/P1-3", {"value": 1})  # refused: the scenario above
    except urllib.error.HTTPError:
        pass
    warnings = fppd.get("/fppd/status").get("warnings", [])
    named = [w for w in warnings if w.startswith("Pin P1-3 is claimed by")]
    assert named and f"Disable {function} in config.txt" in named[0] and \
        any(c in named[0] for c in children), warnings
    assert os.path.islink(os.path.join("/sys/bus/platform/devices", device, "driver"))


def test_a_plain_gpio_output_on_a_uart_pad_is_requested(pads, pinctrl, debugfs, fppd):
    """POST /api/gpio/P1-10 (GPIO15, uart0 RX, reset mode "a0") as a plain
    output requests the line: the API answers 200 and gpioinfo shows fppd
    holding it as an output. Driven low only, the WS281x and enable-pin
    idle level, in case something on the device is wired there.

    Regression: fa30658a0. configPin() re-muxed the pad with pinctrl and
    returned before the gpiod request, so the pin looked configured and
    never drove (a cape's port enable on P1-10 stayed off: #2979). Since
    a988c3ad3 the API then answers 409 instead of a false success.
    """
    if pinmux_owner(15):
        pytest.skip(f"GPIO15 is held by {pinmux_owner(15)} here")
    free_line(15)
    fppd.start()
    r = fppd.post("/gpio/P1-10", {"value": 0})
    assert isinstance(r, dict) and r.get("Status") != "ERROR", r
    info = line_info(15)
    assert "consumer=" in info and "output" in info, info


PWM_PINS = {"P1-13": 27, "P1-32": 12, "P1-33": 13, "P1-12": 18, "P1-35": 19}


def test_a_pwm_output_whose_pwm_cannot_be_set_up_starts(pads, pinctrl, debugfs, fppd):
    """A GPIO output in PWM mode on a PWM pin whose PWM channel can't be
    exported (read-only /sys here; no PWM overlay on a real board) starts,
    and fppd carries on through test mode over it.

    Regression: 8609826b7. setupPWM() failed and left the duty-cycle file
    unopened, and GPIOOutput::Init() then called setPWMValue(), which
    fprintf()ed to it: SIGSEGV at startup.

    Also e44a2d9e7: setupPWM() itself fprintf()ed to each sysfs file it
    failed to open, the export first (SIGSEGV in setupPWM()); shown red on a
    device against master with those checks taken out.
    """
    pin = next((p for p, g in PWM_PINS.items() if not pinmux_owner(g) and
                "consumer=" not in line_info(g)), None)
    if not pin:
        pytest.skip("no free PWM-capable header pin here")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "GPIO", "startChannel": 1, "channelCount": 1, "pin": pin,
        "pwm": 1, "invert": 0}]})
    fppd.start()
    fppd.command("Test Start", 1000, "RGB Cycle", "1-3", "R-G-B")
    time.sleep(3)
    fppd.get("/fppd/status")
    fppd.command("Test Stop")
    assert pinctrl.calls(), "the output never muxed its pin for PWM"
