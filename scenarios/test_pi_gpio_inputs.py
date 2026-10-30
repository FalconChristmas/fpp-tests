"""gpio.json inputs on real Raspberry Pi header lines, pressed by flipping the
pad's pull with the real pinctrl: on a pin with nothing wired to it, the
line follows its pull, so pull-up is a press and pull-down a release, and
the kernel sees real edges on the line fppd requested.

Each input's commands run a script that appends its argument and its PID
to a file: PIDs come in fork order in run-local.sh's PID namespace, so
sorting by them gives the order fppd started the scripts in, whatever
order they finish in.

Device only: run with run-local.sh on a Pi. The pins used are plain header
GPIOs no one holds and that no cape here wires (gpioinfo shows no
consumer); the pads are put back after each scenario.
"""

import contextlib
import functools
import os
import re
import subprocess
import time

import pytest

import hosttools
import shims
from test_gpio_pins import PLAIN_PINS, free_pins, pads  # noqa: F401 -- pads is a fixture
from test_mqtt_control import PORT, broker

# Plain header GPIOs, those of PLAIN_PINS a K2/K4/K8 cape doesn't wire
# (eFuse, enable and data pins sit on P1-7/11/13/15/16), in order.
PINS = ["P1-31", "P1-36", "P1-29", "P1-18", "P1-22"]


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header pins")


# The header GPIOs' gpiochip, by label: pinctrl-bcm2835 (Pi 3), -bcm2711
# (Pi 4), pinctrl-rp1 (Pi 5, whose number has changed between kernels).
HEADER_CHIP_LABELS = ("pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1")


@functools.lru_cache(maxsize=None)
def header_chip():
    """(number, label, line count) of the gpiochip the header's GPIOs are
    on, found by its label rather than assumed to be gpiochip0."""
    out = subprocess.run(["gpiodetect"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        m = re.match(r"gpiochip(\d+) \[([^\]]+)\] \((\d+) lines\)", line)
        if m and m.group(2) in HEADER_CHIP_LABELS:
            return int(m.group(1)), m.group(2), int(m.group(3))
    pytest.skip(f"no Raspberry Pi header gpiochip ({', '.join(HEADER_CHIP_LABELS)})")


def as_expander(*unnamed):
    """gpioexpander.c's environment making the header chip look like an
    expander's: labelled "pcf8575" (the gpiod scan then takes it, and fpp's
    Pi pin table no longer finds it by label), the given lines unnamed. A
    54-line chip is reported with 55 lines, since the pin table would still
    find a Pi 5's rp1 by its 54."""
    c, _, n = header_chip()
    env = {"GPIOEXP_LABEL": f"{c}:pcf8575", "GPIOEXP_NONAME": ",".join(f"{c}:{g}" for g in unnamed)}
    if n == 54:
        env["GPIOEXP_LINES"] = f"{c}:55"
    return env


@contextlib.contextmanager
def lines_kept(gpios):
    """hosttools.pads_kept() for lines fppd may have driven, wrapped round
    fppd's whole life (ask for it before `fppd`). gpiolib keeps the
    direction a line was last requested with after its release, and the
    pad restore goes around gpiolib, so a line fppd drove would go on being
    listed as an output (and free_pins() would take it for one something
    drives). So once fppd has stopped, each line that was an input pad
    before (pinctrl "ip", or "no" -- no function -- on a Pi 5) and is now
    listed as an output nobody holds is read once as an input, and only then
    is the pad put back: on a Pi 5 the read itself moves the pad to "ip"."""
    before = hosttools.pad_states(gpios)
    with hosttools.pads_kept(gpios):
        yield
        for g in gpios:
            info = line_info(g)
            if "output" in info and "consumer=" not in info and \
                    (before.get(g) or "").split()[:1] in (["ip"], ["no"]):
                subprocess.run(["gpioget", "-c", f"gpiochip{header_chip()[0]}", str(g)],
                               capture_output=True)


def line_info(gpio):
    out = subprocess.run(["gpioinfo", "-c", f"gpiochip{header_chip()[0]}", str(gpio)],
                         capture_output=True, text=True).stdout
    return out.strip()


class Button:
    """A free header pin pressed by its pull. Made before fppd starts:
    it parks the pad at pull-down (released) and picks the pin while it
    is still free."""

    def __init__(self, fppd, n=0):
        free = [p for p in PINS if p in free_pins()]
        if len(free) <= n:
            pytest.skip("not enough free plain header GPIOs here")
        self.fppd = fppd
        self.pin = free[n]
        self.gpio = PLAIN_PINS[self.pin]
        self.hits_file = os.path.join(fppd.media, "logs", f"hits-{self.pin}.txt")
        fppd.write("scripts/hit.sh",
                   "#!/bin/sh\n"
                   f'echo "$$ $1" >> "{os.path.dirname(self.hits_file)}/hits-$2.txt"\n')
        os.chmod(os.path.join(fppd.media, "scripts", "hit.sh"), 0o755)
        self.release()

    def run(self, label):
        """A command for gpio.json that records `label` when it runs."""
        return {"command": "Run Script", "args": ["hit.sh", f"{label} {self.pin}", ""]}

    def _pull(self, p):
        subprocess.run([hosttools.real("pinctrl"), "set", str(self.gpio), p], check=True)

    def press(self):
        self._pull("pu")

    def release(self):
        self._pull("pd")

    def hits(self):
        """The labels recorded so far, in the order fppd ran them."""
        try:
            with open(self.hits_file) as f:
                rows = [l.split() for l in f if l.strip()]
        except FileNotFoundError:
            return []
        return [label for _, label in sorted((int(pid), label) for pid, label in rows)]

    def wait_hits(self, n, timeout=5):
        try:
            return self.fppd.wait_for(lambda: len(self.hits()) >= n and self.hits(), timeout=timeout,
                                      what=f"{n} commands run")
        except TimeoutError:
            pytest.fail(f"{self.pin}: {self.hits()} after {timeout} s, wanted {n} commands\n"
                        f"{line_info(self.gpio)}\n{self.fppd.log()[-3000:]}")

    def settled(self, wait=1.0):
        """The labels once nothing more has run for `wait` seconds."""
        last = None
        while self.hits() != last:
            last = self.hits()
            time.sleep(wait)
        return last


def gpio_json(fppd, *inputs):
    fppd.write("config/gpio.json", [dict({"enabled": True, "mode": "gpio_pd"}, **i) for i in inputs])


def test_an_input_with_only_rising_commands_fires_on_every_press(pads, fppd):
    """A gpio.json input with commands for the rising edge only runs them on
    each of three presses, not just the first.

    Regression: d8916665c. With #2644 (c8e1d05e0) the input asked the kernel
    for rising edges only; doAction() fires only when the value read
    differs from the last one, and with no falling edge reported the last
    value stayed 1 after the first press: the input fired once and went
    dead until fppd restarted.
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "rising": [b.run("press")]})
    fppd.start()
    for i in range(3):
        b.press()
        b.wait_hits(i + 1)
        b.release()
        time.sleep(0.3)
    assert b.settled() == ["press"] * 3


def test_an_inputs_command_lists_and_its_hold(pads, fppd):
    """The #2644 input: every command in an edge's list runs, in the list's
    order; a press released before holdTime runs the falling list, and one
    held past it runs the hold list instead, and no falling list on release.

    Regression: c8e1d05e0 (the overhaul that brought command lists and
    hold). Shown red on master with a hand patch taking it back to one
    command an edge (the first of the list) and no hold: the second rising
    command never ran and the long press ran the falling command.
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "holdTime": 1000,
                     "rising": [b.run("rise1"), b.run("rise2")],
                     "falling": [b.run("fall")],
                     "hold": [b.run("hold")]})
    fppd.start()
    b.press()
    time.sleep(0.3)
    b.release()
    b.wait_hits(3)
    assert b.settled() == ["rise1", "rise2", "fall"], "a short press"
    b.press()
    time.sleep(2)
    b.release()
    b.wait_hits(6)
    assert b.settled()[3:] == ["rise1", "rise2", "hold"], "a press held past holdTime"


def test_a_glitch_shorter_than_the_debounce_time_runs_nothing(pads, fppd):
    """With debounceTime 300 ms, a pulse high and back that lasts well
    under it runs no command at all; a press held past it runs the rising
    command once, after the line has settled.

    Regression: aa80695fa. Debouncing fired on the first edge and then
    ignored the line for the debounce time (fire-then-suppress), so any
    glitch ran the rising command at once -- a bounce or noise spike was a
    press. Now an edge fires only after the line has held its new level for
    the whole window. Shown red on master with a hand patch putting the
    fire-on-first-edge back.
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "debounceTime": 300,
                     "rising": [b.run("rise")], "falling": [b.run("fall")]})
    fppd.start()
    time.sleep(0.5)
    b.press()
    b.release()  # a pinctrl call apart: a few ms
    time.sleep(1)
    assert b.settled() == [], "a glitch of a few ms ran commands"
    b.press()
    b.wait_hits(1)
    b.release()
    b.wait_hits(2)
    assert b.settled() == ["rise", "fall"]


def test_an_inputs_request_carries_its_bias(pads, fppd):
    """A gpio_pu input's line, as the kernel holds it for fppd's edge
    events, has the pull-up bias (gpioinfo: bias=pull-up), and a
    gpio_pd input's the pull-down.

    Regression: bae7ebf18. requestEventFile() built the edge-event request
    with no bias, so the line fppd held for events had none: the pull only
    stayed on the pad where the controller keeps it after the earlier
    configPin() request is let go (test_gpio_pins.py's
    test_an_inputs_pull_reaches_the_pad passes either way).
    """
    up, down = Button(fppd, 0), Button(fppd, 1)
    gpio_json(fppd, {"pin": up.pin, "mode": "gpio_pu", "falling": [up.run("x")]},
              {"pin": down.pin, "mode": "gpio_pd", "rising": [down.run("x")]})
    fppd.start()
    got = lambda: (line_info(up.gpio), line_info(down.gpio))
    try:
        fppd.wait_for(lambda: all("edges=" in l for l in got()), timeout=5,
                      what="both lines requested for edges")
    except TimeoutError:
        pytest.fail(f"{got()}")
    assert "bias=pull-up" in got()[0], got()[0]
    assert "bias=pull-down" in got()[1], got()[1]


def test_an_inputs_edges_are_published_over_mqtt(pads, fppd):
    """With MQTT configured, a press and release of a gpio.json input
    publish gpio/<pin>/rising (1) and then gpio/<pin>/falling (0) under
    fppd's topic.

    Regression: f740b4465. aa80695fa's rewrite of doAction() dropped the
    Events::Publish() calls, so nothing was published for GPIO inputs.
    Also af574eaab, which added the publishing (red on a Pi 4 against
    master with the Publish calls removed).
    """
    b = Button(fppd)
    host = "gpiotest"
    gpio_json(fppd, {"pin": b.pin, "rising": [b.run("rise")], "falling": [b.run("fall")]})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=host)
    with broker():
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-v",
                                "-t", f"falcon/player/{host}/gpio/#"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            fppd.start()
            # fppd's MQTT connection comes up a moment after it answers
            fppd.wait_for(lambda: "Mosquitto Connected" in fppd.log(), timeout=15,
                          what="fppd to connect to the broker")
            time.sleep(0.5)
            b.press()
            b.wait_hits(1)
            b.release()
            b.wait_hits(2)
            time.sleep(1)
        finally:
            sub.terminate()
            out = sub.communicate(timeout=5)[0]
    want = [f"falcon/player/{host}/gpio/{b.pin}/rising 1",
            f"falcon/player/{host}/gpio/{b.pin}/falling 0"]
    assert out.splitlines() == want, out


def test_an_input_on_pins_with_no_chip_name_opens_the_chip_by_number(pads, fppd):
    """With the Pi's GPIO chip not recognisable by its label (gpioexpander.c
    reports another), the Pi pin table's pins carry no chip device name; a
    gpio.json input on one still fires: its chip is opened as
    /dev/gpiochip<number>, and no "Could not open GPIO chip" warning is
    raised.

    Regression: 3e0360a58. The chip was opened as "/dev/" + its device
    name, which for such a pin is empty: "/dev/" isn't a chip, so the pin
    was never configured and the input never fired.
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "rising": [b.run("press")]})
    fppd.start(preload=[shims.build("gpioexpander.c")], extra_env=as_expander())
    b.press()
    b.wait_hits(1)
    b.release()
    warnings = [w for w in fppd.get("/fppd/warnings") if "Could not open GPIO chip" in str(w)]
    assert not warnings, warnings
