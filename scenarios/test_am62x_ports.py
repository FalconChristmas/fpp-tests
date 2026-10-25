"""Port enable pins (OutputMonitor) on a PocketBeagle2 string cape whose
banks of ports are powered through enable lines on an I2C GPIO expander, as
the K16 capes' are: what fppd drives on those lines as string outputs start,
stop and reload. Against PRUs that never answer (see bbcape.py); the enable
lines are the cape's real ones, read back from gpiolib's debugfs.

Device only: run with run-local.sh on a PocketBeagle2 with such a cape (the
lines are named PixEn-1, PixEn-2, ...; the scenarios skip without them).
Stop the device's own fppd first: it holds them. Skipped elsewhere.
"""

import os
import re
import subprocess
import time

import pytest

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape

DEBUG_GPIO = "/sys/kernel/debug/gpio"


def line_levels(*names):
    """The level fppd drives on each named GPIO line, from gpiolib's debugfs
    listing ("out hi"/"out lo"); None for a line nothing holds as an
    output."""
    if not os.path.exists(DEBUG_GPIO):
        subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"], check=False)
    with open(DEBUG_GPIO) as f:
        text = f.read()
    out = []
    for n in names:
        m = re.search(r"\(" + re.escape(n) + r"\s*\|[^)]*\)\s+out\s+(hi|lo)", text)
        out.append(None if not m else int(m.group(1) == "hi"))
    return tuple(out)


def enable_lines(fppd):
    fake_pru(fppd)
    if not os.path.exists(DEBUG_GPIO):
        subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"], check=False)
    try:
        with open(DEBUG_GPIO) as f:
            text = f.read()
    except OSError:
        pytest.skip("no gpio debugfs")
    if "(PixEn-1 " not in text:
        pytest.skip("no PixEn-1 enable line (not a K16 cape)")
    if re.search(r"\(PixEn-1\s*\|", text):
        pytest.skip("PixEn-1 is held: stop the device's own fppd first")


def banked_cape(name):
    """16 shift register outputs on PRU1, ports 1-4 powered by PixEn-1."""
    outs = [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]
    for n in range(4):
        outs[n]["enablePin"] = "PixEn-1"
    write_string_cape(name, {"driver": "BBShiftString", "outputs": outs})


def save_strings(fppd, cfg):
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))


def test_a_bank_with_pixels_on_one_port_is_powered(fppd):
    """Ports 1-4 share PixEn-1, and only port 2 has pixels. With output
    running the line is driven on, and still is after the config is saved
    again and output restarted.

    Regression: 71da49119. A port with no pixels took the bank's enable
    pin out of the list of pins to drive on -- std::list::remove() drops
    every entry for it, the other ports' as well -- so a bank came on only
    if all of its ports had pixels.
    """
    enable_lines(fppd)
    banked_cape("TestBanks")
    cfg = strings_config("BBShiftString", "TestBanks",
                         [pixel_output(0, 0, 0), pixel_output(1, 10, 0),
                          pixel_output(2, 0, 30), pixel_output(3, 0, 30)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    fppd.wait_for(lambda: line_levels("PixEn-1") == (1,), timeout=15, interval=0.5,
                  what=f"the bank on (last {line_levels('PixEn-1')})")
    fppd.command("Test Stop")
    save_strings(fppd, cfg)
    time.sleep(5)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    fppd.wait_for(lambda: line_levels("PixEn-1") == (1,), timeout=15, interval=0.5,
                  what=f"the bank on after the reload (last {line_levels('PixEn-1')})")
    fppd.command("Test Stop")


def test_a_config_saved_while_outputting_keeps_the_ports_powered(fppd):
    """With a test pattern running and the bank on, the string config is
    saved again (as an upload from xLights does): the reloaded ports come
    back on at once, with no stop and start of output.

    Regression: d61426c2e. Re-registering a port drove its enable pin to
    the off state, and only the AutoEnableOutputs() of an output thread
    start turned it on -- which had already happened -- so the controller
    went on receiving data with every port unpowered.
    """
    enable_lines(fppd)
    banked_cape("TestBanks")
    cfg = strings_config("BBShiftString", "TestBanks", [pixel_output(n, 10, n * 30) for n in range(4)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    fppd.wait_for(lambda: line_levels("PixEn-1") == (1,), timeout=15, interval=0.5,
                  what="the bank on")
    save_strings(fppd, cfg)
    time.sleep(5)
    assert fppd.log().count("Calling Init() on BBShiftString output") == 2, "the config was not reloaded"
    assert line_levels("PixEn-1") == (1,), \
        f"after the reload, with output still running: {line_levels('PixEn-1')}"
    fppd.command("Test Stop")


def line_consumer(name):
    """Who holds the named GPIO line, from gpiolib's debugfs listing; None
    if nothing does."""
    if not os.path.exists(DEBUG_GPIO):
        subprocess.run(["mount", "-t", "debugfs", "debugfs", "/sys/kernel/debug"], check=False)
    with open(DEBUG_GPIO) as f:
        m = re.search(r"\(" + re.escape(name) + r"\s*\|([^)]*)\)", f.read())
    return m.group(1).strip() if m else None


def test_the_efuse_interrupt_is_still_watched_after_a_reload(fppd):
    """A port whose eFuse status pin (P2-27) is watched through a separate
    interrupt pin (P2-25), two lines no K16 or PocketScroller cape uses:
    fppd holds the interrupt line for its eFuse callback, and still does
    after the string config is saved again.

    Regression: e8bce1a7b (its fusePins half; the locking it adds has no
    window a test can hold open without a sanitizer build of its own).
    RemovePortConfiguration() erased the fuse entry by the eFuse pin's
    name, but it is keyed by the interrupt pin's, so the stale entry made
    the reloaded port skip registering the callback: the interrupt line
    was released and a fuse trip after any reload went unseen.
    """
    fake_pru(fppd)
    for line in ("P2.25", "P2.27"):
        if line_consumer(line) is not None:
            pytest.skip(f"{line} is held by {line_consumer(line)}")
    outs = [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]
    outs[0].update({"eFusePin": "P2-27", "eFuseInterruptPin": "P2-25"})
    write_string_cape("TestFuse", {"driver": "BBShiftString", "outputs": outs})
    cfg = strings_config("BBShiftString", "TestFuse", [pixel_output(0, 10, 0)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    assert line_consumer("P2.25") == "FPPD-eFuseInterrupt", line_consumer("P2.25")
    save_strings(fppd, cfg)
    fppd.wait_for(lambda: fppd.log().count("Calling Init() on BBShiftString output") == 2,
                  timeout=20, what="the config to reload")
    time.sleep(3)
    assert line_consumer("P2.25") == "FPPD-eFuseInterrupt", \
        f"after the reload the interrupt line is held by {line_consumer('P2.25')!r}"
