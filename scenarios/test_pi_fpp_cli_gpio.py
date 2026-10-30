"""The `fpp` CLI's -g (ExtGPIO) on a Raspberry Pi header line, through the
test fppd's command socket, seen at the pad with the real pinctrl and at
the line with gpioinfo.

Device only: run with run-local.sh on a Pi; the pin is a plain header GPIO
no one holds (test_pi_gpio_inputs.PINS), put back after the scenario.
"""

import pytest

from test_command_socket import fpp
from test_gpio_pins import PLAIN_PINS
from test_pi_gpio_inputs import line_info, on_pi
from test_pi_gpio_lines import free_pin, pad, pads  # noqa: F401 -- pads is a fixture

pytestmark = pytest.mark.skipif(not on_pi(), reason="Raspberry Pi header pins")


def test_fpp_g_drives_a_pin_nothing_set_up(pads, fppd):
    """`fpp -g <pin> Output 1` with no `fpp -G` first drives the pad high,
    and `Output 0` low: fppd requests the line as an output itself.

    Regression: f38d8981c. ExtGPIO called setValue() on a line nothing had
    requested, which crashed fppd then; with today's guarded setValue() the
    revert is a silent no-op instead: the line stays unrequested and the
    pad isn't driven (shown on master with the two configPin() calls
    removed)."""
    pin = free_pin()
    gpio = PLAIN_PINS[pin]
    fppd.start()
    rc, out = fpp(fppd, "-g", pin, "Output", "1")
    assert rc == 0, out
    fppd.wait_for(lambda: pad(gpio)[2] == "hi", timeout=5,
                  what=f"{pin}'s pad to be driven high (pad {pad(gpio)}, line {line_info(gpio)!r})")
    assert "output" in line_info(gpio), line_info(gpio)
    rc, out = fpp(fppd, "-g", pin, "Output", "0")
    assert rc == 0, out
    fppd.wait_for(lambda: pad(gpio)[2] == "lo", timeout=5, what=f"{pin}'s pad to go low")
    fppd.check_alive()
