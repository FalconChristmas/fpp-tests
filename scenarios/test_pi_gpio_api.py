"""GPIO pins through fppd on real Raspberry Pi header lines: the GPIO command's
Opposite action, POST and GET /api/gpio/<pin>, how fppd labels and names the
lines it holds, the log line for a pin it can't configure, an input whose
line can't do edge events, and several inputs at once.

The kernel is the oracle: the real pinctrl for what the pad does
(test_pi_gpio_lines.pad), gpioinfo for who holds a line and how. Inputs are
pressed by flipping the pad's pull (test_pi_gpio_inputs.Button).

Device only: run with run-local.sh on a Pi. The pins are plain header GPIOs no
one holds (test_pi_gpio_inputs.PINS), put back after each scenario.
"""

import urllib.error

import pytest

import shims
from test_pi_gpio_inputs import Button, as_expander, gpio_json, line_info, on_pi
from test_gpio_pins import PLAIN_PINS
from test_pi_gpio_lines import free_pin, pad, pads  # noqa: F401 -- pads is a fixture

pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header pins")


def wait_pad(fppd, gpio, level, what):
    fppd.wait_for(lambda: pad(gpio)[2] == level, timeout=5,
                  what=f"{what} (pad {pad(gpio)}, line {line_info(gpio)!r})")


def test_the_gpio_commands_opposite_flips_the_pin(pads, fppd):
    """The GPIO command's "Opposite" drives the pin to the other level from
    the one it last set: On, then Opposite twice, takes the pad high, low,
    high.

    Regression: 87dd120d9, which made the command's second argument an
    action (On/Off/Opposite) rather than a bool; Opposite was unknown
    before it ("Invalid Action").
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    fppd.start()
    fppd.command("GPIO", pin, "On")
    wait_pad(fppd, gpio, "hi", f"{pin} driven high by On")
    fppd.command("GPIO", pin, "Opposite")
    wait_pad(fppd, gpio, "lo", f"{pin} driven low by the first Opposite")
    fppd.command("GPIO", pin, "Opposite")
    wait_pad(fppd, gpio, "hi", f"{pin} driven high by the second Opposite")


def test_api_gpio_pin_post_drives_it_and_get_reads_it_back(pads, fppd):
    """POST /api/gpio/<pin> {"value": 1} drives the pad high and GET
    /api/gpio/<pin> then answers value 1; {"value": 0} drives it low and
    GET answers 0.

    Regression: 4ede3f0c8, which added GET and POST /api/gpio/<pin>; before
    it neither route existed (404). (GET's reading the hardware was replaced
    by 4002d04e8's cached value, the next scenario.)
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    fppd.start()
    fppd.post(f"/gpio/{pin}", {"value": 1})
    wait_pad(fppd, gpio, "hi", f"{pin} driven high")
    assert fppd.get(f"/gpio/{pin}").get("value") == 1
    fppd.post(f"/gpio/{pin}", {"value": 0})
    wait_pad(fppd, gpio, "lo", f"{pin} driven low")
    assert fppd.get(f"/gpio/{pin}").get("value") == 0


def test_reading_an_output_back_leaves_it_driven(pads, fppd):
    """GET /api/gpio/<pin> on an output set high answers 1 and leaves the
    pin an output driven high; on a pin nothing has set it answers 400 and
    leaves the line alone.

    Regression: 4002d04e8. GET configured the pin as an input to read it:
    the output was let go (its line an input, the pad following its pull)
    by the act of asking what it was set to.
    """
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    other = next((p for p in ("P1-36", "P1-29", "P1-18", "P1-22", "P1-31") if p != pin), None)
    fppd.start()
    fppd.post(f"/gpio/{pin}", {"value": 1})
    wait_pad(fppd, gpio, "hi", f"{pin} driven high")
    for _ in range(3):
        assert fppd.get(f"/gpio/{pin}").get("value") == 1
    assert pad(gpio)[0] == "op" and pad(gpio)[2] == "hi", (pad(gpio), line_info(gpio))
    assert "output" in line_info(gpio), line_info(gpio)
    before = line_info(PLAIN_PINS[other])
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.get(f"/gpio/{other}")
    assert e.value.code == 400, e.value.body
    assert line_info(PLAIN_PINS[other]) == before


def test_an_inputs_line_is_labelled_for_what_holds_it(pads, fppd):
    """A gpio.json input's line, once fppd has asked it for edge events,
    shows as consumer "FPPD-GPIO Input" in gpioinfo.

    Regression: 809bd6a19 (the edge-event request took over the consumer
    configPin gave the line; it was requested again as plain "FPPD") and
    e4b2660f9 (which gave gpio.json inputs their "GPIO Input" description).
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "rising": [b.run("press")]})
    fppd.start()
    info = line_info(b.gpio)
    assert 'consumer="FPPD-GPIO Input"' in info and "edges=" in info, info


def test_an_input_whose_line_cannot_do_edges_is_polled_with_no_warning(pads, fppd):
    """A gpio.json input whose line refuses edge detection (gpiorefuse.c
    plays a GPIO expander wired without its interrupt line) is read by
    polling instead: a press still runs its command, the line is held as a
    plain input, and no warning is raised about it.

    Regression: e4b2660f9 (when the edge request failed, the line was left
    unrequested, so polling read a flat 0 and the input never fired; on
    libgpiod v2 the re-request is d56462a9d's) and e1dc74a95 (the fallback
    raised a "Could not configure pin ... for events" warning, though the
    input works).

    Also cc618a607 and 4bf0bfeb4: with no edge detection requested the
    line shows no "edges=" and the press is never seen, not polled either.
    """
    b = Button(fppd)
    gpio_json(fppd, {"pin": b.pin, "rising": [b.run("press")]})
    fppd.start(preload=[shims.build("gpiorefuse.c")],
               extra_env={"GPIOREFUSE": "edges", "GPIOREFUSE_LINE": str(b.gpio)})
    info = line_info(b.gpio)
    assert "consumer=" in info and "edges=" not in info, info
    b.press()
    b.wait_hits(1)
    b.release()
    warnings = [w for w in fppd.get("/fppd/warnings") if b.pin in str(w)]
    assert not warnings, warnings


def test_a_pin_that_cannot_be_configured_is_logged(fppd):
    """A gpio.json input on a pin a kernel driver holds (P1-3, GPIO2, i2c1's
    SDA) can't be configured: the warning that says so is in fppd's log
    too, naming the pin, what wanted it and the mode.

    Regression: 4b1a6f263. The failure was only a warning on the web UI,
    gone after a restart and in no log or support zip.
    """
    if 'consumer="kernel"' not in line_info(2):
        pytest.skip("GPIO2 is not held by a kernel driver here (i2c1 off)")
    gpio_json(fppd, {"pin": "P1-3", "mode": "gpio", "rising": [{"command": "Set Variable",
                                                              "args": ["X", "1"]}]})
    fppd.start()
    log = fppd.log()
    assert "Could not configure pin P1-3(GPIO Input) as gpio" in log, log[-3000:]


def test_an_expander_line_is_named_by_its_line_name(pads, fppd):
    """A GPIO expander's line that has a name (here the header chip, which
    gpioexpander.c labels "pcf8575", so fpp's gpiod scan lists it as an
    expander's) is listed in /api/gpio under that name, "GPIO<n>", and a
    gpio.json input on that name fires; an unnamed line keeps
    "pcf8575-<line>".

    Regression: 0e8822e68. Every expander line was listed as
    "<chip label>-<line>", and that chip/line can change from boot to boot,
    so a configured pin could end up on another line.
    """
    b = Button(fppd)
    unnamed = next(g for p, g in PLAIN_PINS.items() if g != b.gpio)
    gpio_json(fppd, {"pin": f"GPIO{b.gpio}", "rising": [b.run("press")]})
    fppd.start(preload=[shims.build("gpioexpander.c")], extra_env=as_expander(unnamed))
    pins = [p.get("pin") for p in fppd.get("/gpio")]
    assert f"GPIO{b.gpio}" in pins and f"pcf8575-{b.gpio}" not in pins, pins
    assert f"pcf8575-{unnamed}" in pins, pins
    b.press()
    b.wait_hits(1)


def test_several_inputs_each_run_their_own_command(pads, fppd):
    """Three gpio.json inputs with edge events: a press on each runs that
    input's command, the first one's included. glibc's MALLOC_PERTURB_
    fills freed memory, so an input whose state had moved would not run.

    Regression: ee1e8e190. The inputs' states were kept by value in a
    vector, and each event callback held a reference into it: adding the
    second input reallocated the vector, so the first input's callback
    pointed at freed memory.
    """
    buttons = [Button(fppd, n) for n in range(3)]
    gpio_json(fppd, *[{"pin": b.pin, "rising": [b.run(f"press{i}")]}
                      for i, b in enumerate(buttons)])
    fppd.start(extra_env={"MALLOC_PERTURB_": "165"})
    for i, b in enumerate(buttons):
        assert "edges=" in line_info(b.gpio), line_info(b.gpio)
        b.press()
        assert b.wait_hits(1) == [f"press{i}"]
        b.release()
    fppd.check_alive()
