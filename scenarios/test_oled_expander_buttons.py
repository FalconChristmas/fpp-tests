"""fppoled's buttons when they hang off an I2C GPIO expander, on a fake
SSD1306 (oled.py): what a press does to the display.

There is no expander here. The buttons are free Raspberry Pi header lines,
pressed by flipping their pads' pulls with the real pinctrl (as in
test_pi_gpio_inputs.py), and shims make the kernel treat them the way an
expander's lines are treated:
- gpioexpander.c: the header's gpiochip (found by label: a Pi 3/4's
  pinctrl-bcm2835/2711, a Pi 5's pinctrl-rp1) labelled as an expander
  ("pcf8575": fpp's gpiod scan skips the SoC's own chip), lines with no names, so fpp calls them
  pcf8575-<line> as a cape's cape-inputs.json "chip" and "line" find an
  expander's; and a line whose irqchip interrupts on every change and has
  every event stamped with the one edge asked for (pcf857x, pca9675);
- gpiorefuse.c: a line whose chip has no irq (an expander wired without its
  INT line), so an edge request fails.

Device only: run-local.sh on a Pi (fppoled isn't built in a container).
"""

import json
import subprocess
import time

import pytest

import hosttools
import shims
from test_gpio_pins import PLAIN_PINS, free_pins
from test_oled import oled_media, screen  # noqa: F401 -- fixtures
from test_pi_gpio_inputs import PINS, as_expander, header_chip, line_info, on_pi

pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header lines")


def lines(n):
    free = [p for p in PINS if p in free_pins()]
    if len(free) < n:
        pytest.skip(f"needs {n} free plain header GPIOs")
    return [(p, PLAIN_PINS[p]) for p in free[:n]]


def pull(gpio, p):
    subprocess.run([hosttools.real("pinctrl"), "set", str(gpio), p], check=True)


def main_menu(f):
    """The main menu, as it opens: its first item, Tethering, selected."""
    return "Tethering" in f.text()


def nav(button, edge="falling"):
    return [{"command": "OLED Navigation", "args": [button]}] if edge else []


def held_by_fppoled(*gpios):
    return all("FPPOLED" in line_info(g) for g in gpios)


def test_a_polled_expander_button_reads_its_line(oled_media, screen):
    """A gpio.json OLED button (Enter, on the falling edge) on a line whose
    chip has no irq (gpiorefuse.c refuses its edge request) is polled: the
    display stays on the status page with the button untouched, and one
    press opens the main menu.

    Regression: d56462a9d. A polled button's action had no pin to read and
    was checked against a value of 0, which is "pressed" for a falling-edge
    button: Enter fired on every poll with nothing pressed.
    """
    (pin, gpio), = lines(1)
    oled_media.put("config/gpio.json", json.dumps([
        {"pin": pin, "enabled": True, "mode": "gpio_pu", "rising": [], "falling": nav("Enter")}]))
    with hosttools.pads_kept([gpio]):
        try:
            screen.start(preload=[shims.build("gpiorefuse.c")],
                         extra_env={"GPIOREFUSE": "edges", "GPIOREFUSE_LINE": str(gpio)})
            screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            time.sleep(3)
            early = [f for f in screen.frames() if main_menu(f)]
            assert not early, "the main menu opened with no button pressed"
            assert held_by_fppoled(gpio), line_info(gpio)
            pull(gpio, "pd")
            time.sleep(0.15)
            pull(gpio, "pu")
            screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")
        finally:
            screen.stop()


def expander_inputs(interrupt, buttons):
    """cape-inputs.json for buttons on an expander: an interrupt line on a
    header pin and the buttons as lines of the "expander" chip."""
    return json.dumps({"inputs": [{
        "pin": interrupt, "mode": "gpio_pu", "edge": "falling", "type": "gpiod",
        "chip": "pcf8575", "actions": [{"action": a, "line": g} for a, g in buttons]}]})


def press_expander(interrupt_gpio, button_gpio):
    """The expander's button goes low, then its INT line pulses low; then
    the button is let go, with another INT pulse."""
    pull(button_gpio, "pd")
    pull(interrupt_gpio, "pd")
    time.sleep(0.15)
    pull(interrupt_gpio, "pu")
    pull(button_gpio, "pu")
    pull(interrupt_gpio, "pd")
    time.sleep(0.05)
    pull(interrupt_gpio, "pu")


def start_expander(oled_media, screen, n):
    """fppoled with an expander of n buttons on free lines: returns the
    interrupt line and the buttons' lines, once fppoled holds them all and
    the buttons are pulled up (released)."""
    pins = lines(n + 1)
    (ipin, igpio), buttons = pins[0], [g for _, g in pins[1:]]
    return ipin, igpio, buttons, as_expander(*buttons)


def wait_held(screen, *gpios):
    deadline = time.monotonic() + 30
    while not held_by_fppoled(*gpios):
        if time.monotonic() > deadline or screen.proc.poll() is not None:
            pytest.fail(f"fppoled never held {gpios}: {[line_info(g) for g in gpios]}\n{screen.log()}")
        time.sleep(0.2)


def test_an_expander_button_runs_its_own_action(oled_media, screen):
    """Two expander buttons, Up on one line and Enter on the next, behind
    one interrupt line: pressing Enter opens the main menu.

    Regression: a91a50700. On an interrupt, each button's action was
    checked against the interrupt edge's value, not its own line's: every
    button matched, the first listed (Up) won, and Enter never ran.
    """
    ipin, igpio, buttons, env = start_expander(oled_media, screen, 2)
    oled_media.put("tmp/cape-inputs.json", expander_inputs(ipin, zip(("Up", "Enter"), buttons)))
    with hosttools.pads_kept([igpio, *buttons]):
        try:
            screen.start(preload=[shims.build("gpioexpander.c")], extra_env=env)
            wait_held(screen, igpio, *buttons)
            for g in buttons:
                pull(g, "pu")
            screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            time.sleep(0.5)
            press_expander(igpio, buttons[1])
            screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")
        finally:
            screen.stop()


def test_expander_buttons_are_labelled_and_dispatched_by_action(oled_media, screen):
    """fppoled names each expander line's request after its button
    (gpioinfo consumer FPPOLED-Enter) and the interrupt line's FPPOLED-
    Interrupt, and a press dispatches the button's action (Enter opens the
    main menu), not the input's type.

    Regression: f8eb37187. The button's action was created with the input's
    type, "gpiod", for its name, so a press dispatched "gpiod", which no
    page knows; the lines were labelled FPPOLED-FPPOLED and FPPOLED.
    """
    ipin, igpio, buttons, env = start_expander(oled_media, screen, 1)
    oled_media.put("tmp/cape-inputs.json", expander_inputs(ipin, [("Enter", buttons[0])]))
    with hosttools.pads_kept([igpio, *buttons]):
        try:
            screen.start(preload=[shims.build("gpioexpander.c")], extra_env=env)
            wait_held(screen, igpio, *buttons)
            pull(buttons[0], "pu")
            assert 'consumer="FPPOLED-Enter"' in line_info(buttons[0]), line_info(buttons[0])
            assert 'consumer="FPPOLED-Interrupt"' in line_info(igpio), line_info(igpio)
            screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            time.sleep(0.5)
            press_expander(igpio, buttons[0])
            screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")
        finally:
            screen.stop()


def tap(gpio, hold=0.3):
    pull(gpio, "pd")
    time.sleep(hold)
    pull(gpio, "pu")
    time.sleep(1)


def test_one_press_on_an_any_edge_expander_line_acts_once(oled_media, screen):
    """A gpio.json OLED button (Down, falling edge) on a line behind an
    irqchip that interrupts on every change (gpioexpander.c's ANYEDGE), in
    the main menu: one press and release moves the selection one item, so
    one press of Up (a plain line) brings the menu back as it opened.

    Regression: dde0cc054. fppoled asked the kernel for the falling edge
    only; for such a chip gpiolib then stamps every interrupt "falling", so
    the release came back as another press and Down moved two items. It
    asks for both edges now, and gpiolib reports the real direction.
    """
    (penter, genter), (pup, gup), (pdown, gdown) = lines(3)
    oled_media.put("config/gpio.json", json.dumps([
        {"pin": p, "enabled": True, "mode": "gpio_pu", "rising": [], "falling": nav(b)}
        for p, b in ((penter, "Enter"), (pup, "Up"), (pdown, "Down"))]))
    with hosttools.pads_kept([genter, gup, gdown]):
        try:
            screen.start(preload=[shims.build("gpioexpander.c")],
                         extra_env={"GPIOEXP_ANYEDGE": f"{header_chip()[0]}:{gdown}"})
            screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            wait_held(screen, genter, gup, gdown)
            time.sleep(0.5)
            tap(genter)
            screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")
            opened = screen.frames()[-1]
            tap(gdown)
            moved = screen.frames()[-1]
            assert moved.data != opened.data, "Down didn't move the selection"
            tap(gup)
            back = screen.frames()[-1]
            assert back.data == opened.data, \
                f"one Down and one Up left the menu at:\n{back.text()}\n---- not ----\n{opened.text()}"
        finally:
            screen.stop()

def test_fppoled_waits_for_an_expander_that_registers_late(oled_media, screen, tmp_path):
    """fppoled started before the expander's gpiochip is there (it shows up
    with its expander label 2 s later, as when its I2C driver probes after
    cape detection) waits for it, then finds the button on it: a press
    opens the main menu.

    Regression: 609c9f464. fppoled parsed its inputs at once: the expander
    lines didn't resolve, each button was skipped (or polled on the null
    pin), and the buttons never worked until fppoled was restarted.
    """
    ipin, igpio, buttons, env = start_expander(oled_media, screen, 1)
    flag = str(tmp_path / "expander-probed")
    oled_media.put("tmp/cape-inputs.json", expander_inputs(ipin, [("Enter", buttons[0])]))
    with hosttools.pads_kept([igpio, *buttons]):
        try:
            screen.start(preload=[shims.build("gpioexpander.c")], extra_env=dict(env, GPIOEXP_LABEL_FLAG=flag))
            time.sleep(2)
            open(flag, "w").close()
            wait_held(screen, igpio, *buttons)
            pull(buttons[0], "pu")
            screen.wait_for(lambda f: True, timeout=30, what="a first frame")
            time.sleep(0.5)
            press_expander(igpio, buttons[0])
            screen.wait_for(main_menu, timeout=5, what="the main menu after Enter")
        finally:
            screen.stop()
