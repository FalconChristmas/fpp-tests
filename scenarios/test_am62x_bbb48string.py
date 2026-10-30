"""BBB48String (strings on header pins, driven by the PRU writing the GPIO
controllers) on the real PRUs of a PocketBeagle2, under run-local.sh
--host-pru (see pru.py). Its program is assembled at runtime from
/opt/fpp/src, so the tree's sources are bound over the overlay's first.

The string pins are two plain GPIO lines (P2-25, P2-10) the K-series and
PocketScroller capes leave free (skipped if something holds them); run-local.sh's stub pinctrl leaves
their pads as they are.

Device only: run with run-local.sh --host-pru on a PocketBeagle2 with the
device's own fppd stopped. Skipped elsewhere.
"""

import os
import time

import pytest

from am335x import _bind_tree_sources
from bbcape import pixel_output, strings_config, write_string_cape
import pru
from pru import real_pru  # noqa: F401 (a fixture)
from test_am62x_string_pins import consumer, gpio_debugfs

PINS = ["P2-25", "P2-10"]
COMMAND, RESPONSE = 4, 8  # BBB48StringData, in PRU1's data RAM


def save_strings(fppd, cfg):
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))


def taking_frames(p):
    """True once PRU1 is running and has taken a frame: the firmware zeroes
    the command and sets the response to 1 as it takes each one."""
    return not p.halted(1) and p.dram(1, RESPONSE) == 1


def test_the_string_program_takes_frames_again_after_a_reload(real_pru, fppd):
    """A two-port BBB48String output on PRU1 takes frames from a test
    pattern; the string config is saved again (as an upload from xLights
    does): the restarted program runs and takes frames, as the first one
    did.

    Regression: e8d4025ff. A stop leaves 0xFFFF (exit) in the control
    block, and the program used to start by setting its response and then
    reading the command: run() no longer clears the data RAM, and the
    ARM's write of a 0 lands after the program's first read, so it read
    the old exit and halted -- the strings went dark until fppd restarted.
    It now zeroes its control block first. (On the board here the red
    shows on the first start already: the board's own string output,
    stopped for the test, left its exit word in PRU1's data RAM.)
    """
    held = [p for p in PINS if consumer(gpio_debugfs(), p)]
    if held:
        pytest.skip(f"{held} are held on this board")
    _bind_tree_sources(fppd.tree)
    write_string_cape("TestWS2", {"outputs": [{"pin": p} for p in PINS]})
    cfg = strings_config("BBB48String", "TestWS2", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=90)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    with pru.Pruss() as p:
        fppd.wait_for(lambda: taking_frames(p), timeout=30,
                      what=f"PRU1 to take frames (control {p.control(1):#x}, response {p.dram(1, RESPONSE):#x})")
        save_strings(fppd, cfg)
        fppd.wait_for(lambda: fppd.log().count("Calling Init() on BBB48String output") == 2,
                      timeout=60, what="the config to reload")
        fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not taking_frames(p):
            time.sleep(0.2)
        state = (p.control(1), p.dram(1, COMMAND), p.dram(1, RESPONSE))
    fppd.command("Test Stop")
    assert state[0] & pru.CTRL_RUNSTATE, \
        f"PRU1 halted after the reload: control {state[0]:#x}, command {state[1]:#x}, response {state[2]:#x}"
    assert state[2] == 1, f"PRU1 took no frame after the reload: command {state[1]:#x}, response {state[2]:#x}"


CYCLE = 0xC  # a core's cycle counter, in its control block


def test_the_reset_gap_after_a_frame_lasts_300_us(real_pru, fppd):
    """After each frame the BBB48String program holds the lines low for
    the 300 us WS281x reset: on the AM62x PRU's 250 MHz clock that is
    75000 cycles, read here as the highest value PRU1's cycle counter
    reaches (the program restarts it at each bit and each frame, and lets
    it run through the reset).

    Regression: 74d51b1cd. The AM62x PRUs were taken as 333 MHz (3 ns a
    cycle) while they run at 250 MHz, so every delay -- bit cells and the
    reset -- came out a third long.
    """
    held = [p for p in PINS if consumer(gpio_debugfs(), p)]
    if held:
        pytest.skip(f"{held} are held on this board")
    _bind_tree_sources(fppd.tree)
    write_string_cape("TestWS2", {"outputs": [{"pin": p} for p in PINS]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestWS2", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)]))
    fppd.start(timeout=90)
    fppd.command("Test Start", "25", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    with pru.Pruss() as p:
        fppd.wait_for(lambda: taking_frames(p), timeout=30, what="PRU1 to take frames")
        top = 0
        deadline = time.monotonic() + 3
        reg = pru.CTRL[1] + CYCLE
        while time.monotonic() < deadline:
            for _ in range(1000):
                v = p.read32(reg)
                if v > top:
                    top = v
    fppd.command("Test Stop")
    assert 0.95 * 75000 < top < 1.1 * 75000, f"PRU1's cycle counter peaked at {top} ({top * 4 / 1000:.0f} us at 4 ns)"
