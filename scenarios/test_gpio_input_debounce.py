"""A gpio.json input's own debounce time, on one of fppd's TF-n test pins
(high while /tmp/GPIO-TF-n exists, read each main loop pass), so it runs
in Docker. test_pi_gpio_inputs.py has the same on real Pi header lines.
"""

import os
import time

from test_conditions import set_variable, variable

PIN, FLAG = "TF-6", "/tmp/GPIO-TF-6"
VAR = "DebouncedPress"


def test_a_pulse_shorter_than_the_inputs_debounce_time_runs_nothing(fppd):
    """An input with debounceTime 1500 ms: a press that lasts half a second
    runs nothing, and one held past the 1.5 s runs its rising command.

    Regression: 032873141. Every input was debounced by a fixed 100 ms,
    whatever its gpio.json said, so the half-second press ran the command.
    """
    if os.path.exists(FLAG):
        os.unlink(FLAG)
    fppd.write("config/gpio.json", [{
        "pin": PIN, "enabled": True, "mode": "gpio", "desc": "debounced",
        "debounceTime": 1500, "debounceEdge": "both",
        "rising": [set_variable(VAR, "pressed")], "falling": [], "holdTime": 0, "hold": []}])
    fppd.start()
    try:
        time.sleep(1)  # the input reads the line low first
        open(FLAG, "w").close()
        time.sleep(0.5)
        os.unlink(FLAG)
        time.sleep(2.5)
        assert variable(fppd, VAR) == "", "a 0.5 s press ran the rising command through a 1.5 s debounce"

        open(FLAG, "w").close()
        fppd.wait_for(lambda: variable(fppd, VAR) == "pressed", timeout=10,
                      what="a press held past the debounce time to run its command")
    finally:
        if os.path.exists(FLAG):
            os.unlink(FLAG)
