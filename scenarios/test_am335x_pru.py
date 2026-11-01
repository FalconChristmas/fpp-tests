"""PRU outputs (BBB48String, BBBMatrix, BBBSerial) and the PRU loader on an
AM335x BeagleBone, against the fake PRU subsystem of am335x.py and
fakepruss.c: the outputs' Init, PrepData, SendData and Close run in full, the
PRU programs are assembled from the tree, and a scenario reads back what
was loaded onto each core and written to the PRU memories.

Device only: run with run-local.sh on a BeagleBone Black or a PocketBeagle.
The GPIO lines are the real ones, so stop the device's own fppd first.
Skipped elsewhere.
"""

import os
import struct
import time

import pytest

from am335x import (FakePruss, pocketbeagle, stock_panel_pinout, write_panel_pinout,
                    write_string_cape)
from bbcape import pixel_output, strings_config

PINCTRL_LOG = "/tmp/pinctrl.log"


def pinctrl_mark():
    try:
        return os.path.getsize(PINCTRL_LOG)
    except OSError:
        return 0


def pinctrl_calls(since=0):
    """What fppd asked run-local.sh's stub pinctrl to do, from byte `since`."""
    try:
        with open(PINCTRL_LOG) as f:
            f.seek(since)
            return f.read().splitlines()
    except OSError:
        return []


def string_pins():
    """Header pins for string outputs: four on GPIO1/2 banks, then two on
    GPIO0."""
    if pocketbeagle():
        return ["P2-02", "P2-04", "P2-06", "P2-08"], ["P2-09", "P2-11"]
    return ["P8-07", "P8-08", "P8-09", "P8-10"], ["P9-11", "P9-13"]


def warnings_of(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def test_a_bbb48string_output_starts_on_the_fake_pru(fppd):
    """Smoke: a two-port BBB48String output builds its firmware, loads it
    on PRU1 and sends frames.

    Regression: b9cf627e1. On a mainline kernel (no /sys/class/gpio) the
    pin map's opendir() came back NULL and readdir() on it killed fppd
    with SIGSEGV as the first pin was looked up.

    Regression: b135696d0 and 4b53c59d4, the AM335x program assembled at
    runtime: DISABLE_PIN_INTERRUPTS lost its .endm, and NSPERCLK (used by
    the timeout waits) had no AM335x value; either way the program failed
    to build and the output never started.
    """
    pru = FakePruss(fppd)
    pins, _ = string_pins()
    write_string_cape("TestTwo", {"outputs": [{"pin": p} for p in pins[:2]]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestTwo", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)]))
    fppd.settings(LogLevel_ChannelOut="debug")
    pru.start()
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(3)
    starts = pru.starts(1)
    assert starts and starts[-1][1].endswith("am335x-pru1-fw.fpp"), (pru.events(), fppd.tail())
    assert not any("BBB48String" in w for w in warnings_of(fppd)), warnings_of(fppd)
    fppd.command("Test Stop")


def save(fppd, rel, cfg):
    """Save a config file the way the UI does, in one rename, so fppd
    reloads it once."""
    tmp = fppd.write(rel + ".new", cfg)
    os.replace(tmp, os.path.join(fppd.media, rel))


def pru_builds(fppd, script):
    """The arguments of each runtime PRU build of `script` (fppd logs them
    at debug), in order."""
    out = []
    for line in fppd.log().splitlines():
        if "Compiling PRU program: " in line and script in line:
            out.append(line.split(script, 1)[1].split())
    return out


def ddr_region(fppd, owner):
    """(start, end) offsets of `owner`'s last allocation in the PRU DDR
    region, from the allocator's log line."""
    found = None
    for line in fppd.log().splitlines():
        if f"DDR region: '{owner}' at " in line:
            a, b = line.split(" at ")[1].split()[0].split("-")
            found = (int(a, 16), int(b, 16))
    return found


# ---- BBB48String ----------------------------------------------------------


def two_port_strings(fppd, name="TestTwo", **over):
    pins, _ = string_pins()
    write_string_cape(name, {"outputs": [{"pin": p} for p in pins[:2]]})
    cfg = strings_config("BBB48String", name, [pixel_output(0, 10, 0), pixel_output(1, 10, 30)])
    cfg["channelOutputs"][0].update(over)
    return cfg


def test_a_restart_with_both_cores_stopped_does_not_touch_pru_memory(fppd):
    """fppd starting a BBB48String output while both PRU cores are stopped
    (as after an fppd that used them exited) starts it without touching
    the PRU memories before the core runs: the fake makes that RAM
    inaccessible while every core is offline, as the PRUSS's can be.

    Regression: 163d57ad4. BBBPru::run() cleared the PRU data and shared RAM
    before enabling the core; with both cores offline that access took an
    external abort (crash bucket e80ad9caf7, SIGBUS in the clear). Here it
    is a SIGSEGV in the clear, and the crash handler runs.
    """
    pru = FakePruss(fppd, states=("offline", "offline"), offline_fault="all")
    fppd.write("config/co-bbbStrings.json", two_port_strings(fppd))
    pru.start()
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(3)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    assert pru.starts(1), pru.events()
    assert pru.remoteproc_state(1) == "running"
    fppd.command("Test Stop")


def test_a_stopped_core_whose_program_undoes_the_stop_is_halted(fppd):
    """When the output closes, its core is halted even though its program
    undoes a clear of the enable bit (the fake undoes the first two after
    each start, as a running program's RESET_PRU_CLOCK read-modify-write of
    CONTROL does when the clear lands between its read and its write).

    Regression: 18902944a. A remoteproc stop cleared EN once; undone, the
    core kept running its old program while remoteproc reported it
    offline, acting on any command word it saw.
    """
    pru = FakePruss(fppd, undo=2)
    cfg = two_port_strings(fppd)
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    assert pru.starts(1), pru.events()
    cfg["channelOutputs"][0]["enabled"] = 0
    save(fppd, "config/co-bbbStrings.json", cfg)
    fppd.wait_for(lambda: pru.remoteproc_state(1) == "offline", timeout=30,
                  what="the output to close")
    time.sleep(1)
    assert not pru.ctrl(1) & 0x8002, (hex(pru.ctrl(1)), pru.events())


def test_two_core_stop_touches_no_pru_memory_after_the_first_core_stops(fppd):
    """A BBB48String output on both PRUs (GPIO0 on PRU0, serialInUse off)
    closes without reading PRU memory once a core is stopped: the fake
    makes the PRUSS RAM inaccessible while any core is offline.

    Regression: fb0685fd5 (the BBB48String half). StopPRU() stopped PRU1
    and only then polled PRU0's response in the PRU data RAM, which took
    an external abort (SIGBUS) when a reload closed a two-PRU output.
    """
    pru = FakePruss(fppd, offline_fault="any")
    pins, gpio0 = string_pins()
    write_string_cape("TestGpio0", {"outputs": [{"pin": pins[0]}, {"pin": gpio0[0]}]})
    cfg = strings_config("BBB48String", "TestGpio0", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)])
    cfg["channelOutputs"][0]["serialInUse"] = False
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    assert pru.starts(0) and pru.starts(1), pru.events()
    cfg["channelOutputs"][0]["enabled"] = 0
    save(fppd, "config/co-bbbStrings.json", cfg)
    fppd.wait_for(lambda: pru.remoteproc_state(0) == "offline" or "Crash handler called" in fppd.log(),
                  timeout=30, what="the output to close")
    time.sleep(1)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")


def test_a_reload_does_not_wait_for_a_running_script(fppd):
    """A strings config saved while a script started by Run Script is still
    running is applied at once: the output's firmware build waits for the
    build alone.

    Regression: 45d4a0708. The build was waited for with wait(NULL), and
    under fppd's SA_NOCLDWAIT that blocks until every child of fppd has
    exited, so the reload (and the output) waited for the 40 s script.
    """
    pru = FakePruss(fppd)
    fppd.write("scripts/hold.sh", "#!/bin/sh\nsleep 40\n")
    os.chmod(os.path.join(fppd.media, "scripts", "hold.sh"), 0o755)
    cfg = two_port_strings(fppd)
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    before = len(pru.starts(1))
    fppd.command("Run Script", "hold.sh")
    time.sleep(2)
    cfg["channelOutputs"][0]["outputs"][0]["virtualStrings"][0]["pixelCount"] = 20
    t0 = time.monotonic()
    save(fppd, "config/co-bbbStrings.json", cfg)
    fppd.wait_for(lambda: len(pru.starts(1)) > before, timeout=60, interval=0.5,
                  what="the reloaded output to start")
    took = time.monotonic() - t0
    assert took < 20, f"the reload took {took:.0f}s"


def v4_strings():
    """A Falcon V4 receiver chain on ports 1-4 holding the longest strings,
    and a shorter plain string on port 5."""
    pins, _ = string_pins()
    more = ["P8-11", "P8-12", "P8-14", "P8-15"] if not pocketbeagle() else ["P2-10", "P2-18", "P2-20", "P2-22"]
    allpins = pins + more
    write_string_cape("TestV4", {"outputs": [{"pin": p} for p in allpins[:5]]})
    ports = [pixel_output(n, 12, n * 36) for n in range(4)] + [pixel_output(4, 6, 144)]
    for p in ports[:4]:
        p["differentialType"] = 16  # one Falcon V4 receiver
    return strings_config("BBB48String", "TestV4", ports)


def test_a_falcon_v4_chain_with_the_longest_strings_builds_its_firmware(fppd):
    """A Falcon V4 receiver chain whose strings are the longest on the
    output builds its firmware, and the output starts with it.

    Regression: 140283c47 (the firmware build half). createOutputLengths
    read one key past the end of its offset map -- a receiver chain has no
    end-of-string command, so the last key was not the longest string's
    end -- and the generated firmware named a label that did not exist, so
    the build failed.

    Also covers 32eb2638c, the V4 support itself: without the chain grouping
    the firmware is built without its FALCONV4 section.
    """
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.write("config/co-bbbStrings.json", v4_strings())
    pru.start()
    w = warnings_of(fppd)
    assert not any("firmware failed to build" in x or "Could not start PRU" in x for x in w), (w, fppd.tail())
    assert os.path.exists("/tmp/FalconWS281x.out")
    starts = pru.starts(1)
    assert starts, pru.events()
    with open(starts[-1][2], "rb") as a, open("/tmp/FalconWS281x.out", "rb") as b:
        assert a.read() == b.read()
    assert any("-DFALCONV4" in args for args in pru_builds(fppd, "compileWS2811x.sh")), \
        pru_builds(fppd, "compileWS2811x.sh")


def test_the_gpio0_firmware_writes_no_clock_or_priority_registers(fppd):
    """The firmware built for a GPIO0 string output (here on its own PRU)
    has no store to the control module's INITPRIORITY register or through
    the CM_WKUP/CM_MPU/CM_PER setup that addressed the wrong register.

    Regression: 01a7f0ad9. SETUP_GPIO0_REGS addressed INITPRIORITY
    (0x44E10608) plus the GPIO0 base still in r12, writing 8 bytes into
    whatever DDR page sat at 0x89C17608, and did its clock-control stores
    through r13 (0x100), into the PRU's own data RAM. A static check of
    the assembled program: the fake runs no PRU code.
    """
    pru = FakePruss(fppd)
    pins, gpio0 = string_pins()
    write_string_cape("TestGpio0", {"outputs": [{"pin": pins[0]}, {"pin": gpio0[0]}]})
    cfg = strings_config("BBB48String", "TestGpio0", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)])
    cfg["channelOutputs"][0]["serialInUse"] = False
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    assert pru.starts(0), pru.events()
    with open("/tmp/FalconWS281x_gpio0.asm") as f:
        asm = f.read().upper()
    # the mreqprio store the fix kept: the GPIO0 setup is in this build
    assert "0X44E10670" in asm, "no GPIO0 setup in the build"
    for addr in ("0x44E10608", "0x44E00400", "0x44E00000"):
        assert addr.upper() not in asm, addr


# ---- BBBMatrix ------------------------------------------------------------


def matrix_config(w=64, h=32, scan=16, panels=((0, 0),), depth=8, **over):
    """An LED panel output (the LEDscapeMatrix subtype the UI saves on a
    Beagle): one w x h panel at each (output, chain position)."""
    plist = [{"outputNumber": o, "panelNumber": n, "colorOrder": "", "xOffset": n * w,
              "yOffset": o * h, "orientation": "N", "row": o, "col": n} for o, n in panels]
    width = w * (1 + max(n for _, n in panels))
    height = h * (1 + max(o for o, _ in panels))
    c = {"type": "LEDPanelMatrix", "subType": "LEDscapeMatrix", "enabled": 1, "startChannel": 1,
         "channelCount": width * height * 3, "ledPanelsWidth": w, "ledPanelsHeight": h,
         "panelWidth": w, "panelHeight": h, "panelScan": scan, "ledPanelsScan": scan,
         "colorOrder": "RGB", "gamma": "1.0", "brightness": 10, "panelColorDepth": depth,
         "panelInterleave": "0", "panelOutputOrder": False, "invertedData": 0, "panels": plist}
    c.update(over)
    return {"channelOutputs": [c]}


def octoscroller(**over):
    """The Octoscroller pinout (a BBB panel cape: PRU0, GPIO clock), as
    the cape's own panel config."""
    p = stock_panel_pinout("Octoscroller")
    p.update(over)
    write_panel_pinout(p["name"], p)
    return p


def needs_bbb():
    if pocketbeagle():
        pytest.skip("uses the BeagleBone Black's Octoscroller pinout")


def matrix_builds(fppd):
    return pru_builds(fppd, "compileMatrix.sh")


def test_a_matrix_config_warning_comes_down_when_the_config_is_fixed(fppd):
    """A panel config naming a pinout the cape doesn't have warns, and the
    warning comes down when a config with the cape's own pinout is saved
    -- with no restart.

    Regression: 46da36631. BBBMatrix raised its Init() failures with a plain
    AddWarning(), which an output reload never retracts.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    octoscroller()
    fppd.write("config/channeloutputs.json", matrix_config(wiringPinout="v3"))
    pru.start()

    def missing():
        return [w for w in warnings_of(fppd) if "no output pin configuration for Octoscroller-v3" in w]

    assert missing(), warnings_of(fppd)
    save(fppd, "config/channeloutputs.json", matrix_config())
    fppd.wait_for(lambda: pru.starts(0), timeout=60, what="the fixed output to start")
    fppd.wait_for(lambda: not missing(), timeout=10, what="the warning to come down")


DIMMING = "/home/fpp/media/config/ledscape_dimming"


def test_a_long_line_in_the_dimming_file_is_read_safely(fppd):
    """A developer dimming table (config/ledscape_dimming) with a line of
    150 characters is read without harm, and the panel output starts.

    Regression: 844bcb0b3. The file was read with getline() handed a stack
    array as its buffer; a line of 100 characters or more made getline()
    realloc() the stack, and glibc aborted fppd.

    Also covers e3a1f2558 (its BBBMatrix half): an exit(1) left after the
    firmware build ended fppd before the panel PRU was started.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    octoscroller()
    with open(DIMMING, "w") as f:
        f.write("0\n" + "1F00 " * 30 + "\n" + "8000 10\n")
    try:
        fppd.write("config/channeloutputs.json", matrix_config())
        pru.start()
        fppd.wait_for(lambda: pru.starts(0), timeout=30, what="the panel output to start")
        assert "Crash handler called" not in fppd.log(), fppd.tail()
    finally:
        os.unlink(DIMMING)


def test_saving_the_strings_config_rebuilds_a_ui_saved_panel_output(fppd):
    """With an LED panel output saved by the UI (subtype LEDscapeMatrix)
    enabled, saving a strings config that changes the string outputs
    reloads the panel output: its firmware is rebuilt and its PRU
    restarted.

    Regression: 749468b33. The reload matched only subtype "BBBMatrix",
    which the UI never saves, so the panel PRU program was left as it was.

    Also d09eed5ed: the reload itself. fppd reloaded only the file that
    changed, so a strings save left the panel PRU program (assembled when
    the panel config loads) as it was, whatever the strings now used. Runs
    on a PocketBeagle too, with its own scroller pinout and free pins.
    """
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    octoscroller(singlePRU=True)
    fppd.write("config/channeloutputs.json", matrix_config())
    free = ["P2-18", "P2-20"] if pocketbeagle() else ["P8-17", "P8-19"]
    write_string_cape("TestFree", {"outputs": [{"pin": p} for p in free]})
    cfg = strings_config("BBB48String", "TestFree", [pixel_output(0, 10, 0)])
    cfg["channelOutputs"][0]["enabled"] = 0
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    fppd.wait_for(lambda: pru.starts(0), timeout=30, what="the panel output to start")
    builds = len(matrix_builds(fppd))
    cfg["channelOutputs"][0]["enabled"] = 1
    cfg["channelOutputs"][0]["startChannel"] = 6145
    save(fppd, "config/co-bbbStrings.json", cfg)
    fppd.wait_for(lambda: pru.starts(1), timeout=60, what="the string output to start")
    fppd.wait_for(lambda: len(matrix_builds(fppd)) > builds and len(pru.starts(0)) > 1,
                  timeout=60, what="the panel output to be rebuilt and restarted")


def test_six_bit_panels_show_the_top_bits_of_each_colour(fppd):
    """At 6 bit depth 0x80 and 0xC0 light the panel: the frame the PRU
    reads from DDR has one bit plane set for 0x80 and two for 0xC0 (bits
    7 and 6 of the 8 bit value).

    Regression: f0290cd1a. PrepData took bits 0-5, the low bits, so both
    came out black: an all-zero frame.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    octoscroller(singlePRU=True)
    fppd.write("config/channeloutputs.json", matrix_config(depth=6))
    pru.start()
    region = ddr_region(fppd, "BBBMatrix")
    assert region, fppd.tail()

    def lit_words():
        f = pru.ddr(region[0], region[1] - region[0])
        return sum(1 for i in range(0, len(f), 4) if f[i:i + 4] != b"\0\0\0\0")

    lit = {}
    for colour in ("#808080", "#C0C0C0"):
        fppd.command("Test Start", "1000", "RGB Single Color", "1-6144", colour)
        time.sleep(3)
        lit[colour] = lit_words()
        fppd.command("Test Stop")
        time.sleep(1)
    assert lit["#808080"] > 0 and lit["#C0C0C0"] == 2 * lit["#808080"], lit


def test_a_one_twentieth_scan_panel_drives_the_e_line(fppd):
    """An 80x40 1/20 scan panel on a cape with an E (sel4) line muxes that
    pin and builds its firmware with the fifth address line: rows 16-19
    need it.

    Regression: 67470f1dd. The E line was enabled for 1/32 scan only, so
    rows 16-19 were driven as rows 0-3.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    p = stock_panel_pinout("Octoscroller")
    p["controls"]["sel4"] = {"pin": "P9-41", "type": "gpio"}
    write_panel_pinout("Octoscroller", p)
    mark = pinctrl_mark()
    fppd.write("config/channeloutputs.json", matrix_config(w=80, h=40, scan=20))
    pru.start()
    builds = matrix_builds(fppd)
    assert builds and "-DE_SCAN_LINE" in builds[-1], builds
    assert any(c.startswith("-s P9_41 ") for c in pinctrl_calls(mark)), pinctrl_calls(mark)


def test_a_gpio_clock_keeps_the_panel_output_on_one_pru(fppd):
    """With the Octoscroller's GPIO clock the panel firmware is built for
    one PRU doing all the output (no SPLIT_GPIO); the same pinout with the
    clock on a PRU pin still splits the GPIO banks across both PRUs.

    Regression: e866c8a8c. A GPIO clock was split too: the clock write is
    posted, so the copy PRU's next pixel could land before the clock edge
    and bleed into its neighbour (~1 pixel in 5).

    Also covers 5816eed4b (the host side of the split): without it the
    PRU-clock pinout is never split either.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    p = octoscroller()
    two = matrix_config(panels=((0, 0), (1, 0)))
    fppd.write("config/channeloutputs.json", two)
    pru.start()
    builds = matrix_builds(fppd)
    assert builds and "-DSPLIT_GPIO" not in builds[-1], builds
    # the control: a PRU clock (P8-12 is pr1_pru0_pru_r30_14) splits
    p["controls"]["clock"] = {"pin": "P8-12", "type": "pruout"}
    p["controls"]["sel0"] = {"pin": "P9-16", "type": "gpio"}
    write_panel_pinout("Octoscroller", p)
    two["channelOutputs"][0]["brightness"] = 9
    n = len(builds)
    save(fppd, "config/channeloutputs.json", two)
    fppd.wait_for(lambda: len(matrix_builds(fppd)) > n, timeout=60, what="the rebuild")
    assert "-DSPLIT_GPIO" in matrix_builds(fppd)[-1], matrix_builds(fppd)


def brightness_args(build):
    return sorted(a for a in build if a.startswith(("-DBRIGHTNESS", "-DDELAY")))


def test_nine_panel_outputs_use_the_last_timing_entry(fppd):
    """A panel cape with more than 8 outputs builds its firmware with the
    brightness timings of the tables' last (8 output) entry: chains of 8
    panels reaching output 9 give the same BRIGHTNESSn/DELAYn as ones
    reaching output 8.

    Regression: d8c38b495 (the BBBMatrix half). The timing tables stop at
    8 outputs and were indexed with the output count unchecked, so 9 or
    more outputs read past the table.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    p = stock_panel_pinout("Octoscroller")
    p["outputs"] = p["outputs"] + p["outputs"]  # 16 outputs
    write_panel_pinout("Octoscroller", p)
    # chains of 8: the 8 output entry is above the timing floor (0x4500)
    eight = matrix_config(panels=((0, 0), (7, 7)))
    fppd.write("config/channeloutputs.json", eight)
    pru.start()
    first = matrix_builds(fppd)
    assert first, fppd.tail()
    nine = matrix_config(panels=((0, 0), (8, 7)))
    save(fppd, "config/channeloutputs.json", nine)
    fppd.wait_for(lambda: len(matrix_builds(fppd)) > len(first), timeout=60, what="the rebuild")
    last = matrix_builds(fppd)[-1]
    assert "-DOUTPUTS=9" in last, last
    assert brightness_args(last) == brightness_args(first[-1]), (first[-1], last)


def test_the_copy_firmware_is_built_for_the_core_it_runs_on(fppd):
    """With the panel output on PRU0, the copy program runs on PRU1 and is
    built for PRU1: its constant table pointers and cycle counter are
    PRU1's control registers (0x24000), not PRU0's (0x22000).

    Regression: eb40380e2. The copy program got the output PRU's
    -DRUNNING_ON_PRU0, so it programmed PRU0's constant table pointers and
    raised PRU0's event. A static check of the assembled program: the
    fake runs no PRU code.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    octoscroller()
    fppd.write("config/channeloutputs.json", matrix_config())
    pru.start()
    assert pru.starts(1) and pru.starts(0), pru.events()
    with open("/tmp/FalconMatrixPRUCpy.asm") as f:
        asm = f.read()
    ctppr = [l.strip() for l in asm.splitlines() if "0x22028" in l or "0x2202C" in l]
    assert ctppr and all("0x2000" in l for l in ctppr), ctppr
    assert "0x00024000" in asm and "0x00022000" not in asm.replace("#define", ""), "PRU0 control register"


# ---- BBBSerial ------------------------------------------------------------


def test_a_serial_output_number_past_the_cape_is_ignored(fppd):
    """A BBBSerial DMX config naming an output far past the cape's 8 is
    ignored, with a log line, and the outputs that exist start.

    Regression: d8c38b495 (the BBBSerial half). m_startChannels[outputNumber]
    was written for any number in the config: far past the end it
    faulted, and fppd crashed at startup.
    """
    pru = FakePruss(fppd)
    pins, _ = string_pins()
    write_string_cape("TestSerial", {"serial": [{"pin": p} for p in pins[:2]]})
    fppd.write("config/co-bbbStrings.json", {"channelOutputs": [{
        "type": "BBBSerial", "subType": "DMX", "enabled": 1, "startChannel": 1, "channelCount": 1024,
        "device": "TestSerial", "pinoutVersion": "1.x",
        "outputs": [{"outputNumber": 0, "startChannel": 1, "channelCount": 512},
                    {"outputNumber": 0x30000000, "startChannel": 513, "channelCount": 512}]}]})
    pru.start()
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    assert "BBBSerial: ignoring output" in fppd.log(), fppd.tail()
    assert pru.starts(), pru.events()


# ---- the PRU loader -------------------------------------------------------


def test_starting_and_stopping_an_output_keeps_the_sleep_firmware(fppd):
    """Starting a PRU output installs its program beside the image's sleep
    firmware, not over it: the core boots the program, the sleep firmware's
    content is unchanged, and once the output stops am335x-pru1-fw links
    back to the sleep firmware, so the next boot parks the PRU.

    Regression: fb0f51dde. The program was copied to am335x-pru1-fw, a
    symlink to the .sleep file, so the copy overwrote the sleep firmware
    itself and every later boot ran the last output program.

    Also c3fb85c7f: the program is installed by CopyFileContents() (sendfile),
    and the core boots the bytes it copied; when the copy fails no core starts.
    """
    pru = FakePruss(fppd)
    cfg = two_port_strings(fppd)
    fppd.write("config/co-bbbStrings.json", cfg)
    pru.start()
    starts = pru.starts(1)
    assert starts, pru.events()
    with open(starts[-1][2], "rb") as f, open("/tmp/FalconWS281x.out", "rb") as g:
        assert f.read() == g.read(), "the core did not boot the output's program"
    cfg["channelOutputs"][0]["enabled"] = 0
    save(fppd, "config/co-bbbStrings.json", cfg)
    fppd.wait_for(lambda: pru.remoteproc_state(1) == "offline", timeout=30, what="the output to stop")
    time.sleep(1)
    with open("/lib/firmware/am335x-pru1-fw.sleep", "rb") as f:
        assert f.read() == FakePruss.sleep_firmware(1), "the sleep firmware was overwritten"
    assert pru.firmware_link(1) == "am335x-pru1-fw.sleep", pru.firmware_link(1)


def serial_config(enabled=1):
    pins, _ = string_pins()
    write_string_cape("TestSerial", {"serial": [{"pin": p} for p in pins[:2]]})
    return {"channelOutputs": [{
        "type": "BBBSerial", "subType": "DMX", "enabled": enabled, "startChannel": 1,
        "channelCount": 1024, "device": "TestSerial", "pinoutVersion": "1.x",
        "outputs": [{"outputNumber": 0, "startChannel": 1, "channelCount": 512},
                    {"outputNumber": 1, "startChannel": 513, "channelCount": 512}]}]}


def test_a_serial_output_whose_pru_never_answers_is_warned_about(fppd):
    """A BBBSerial DMX output whose PRU never takes a frame raises "PRU is
    not consuming frames" while fppd keeps answering, and the output closes
    cleanly on a reload, taking the warning down.

    Regression: 2ebcfbac6 (the stalled-PRU half). The wait for the previous
    frame spun forever on the output thread with nothing in the UI. Its
    other half, the control block written before run() cleared it, doesn't
    show here: the first frame writes the DDR address again.
    """
    pru = FakePruss(fppd)
    fppd.write("config/co-bbbStrings.json", serial_config())
    pru.start()
    assert pru.starts(), pru.events()
    core = pru.starts()[-1][0]
    fppd.command("Test Start", "1000", "RGB Chase", "1-1024", "FF0000-00FF00-0000FF")

    def stalled():
        return [w for w in warnings_of(fppd) if "PRU is not consuming frames" in w]

    fppd.wait_for(stalled, timeout=30, interval=1, what="the stalled-PRU warning")
    fppd.command("Test Stop")
    save(fppd, "config/co-bbbStrings.json", serial_config(enabled=0))
    fppd.wait_for(lambda: pru.remoteproc_state(core) == "offline", timeout=30, what="the output to close")
    fppd.wait_for(lambda: not stalled(), timeout=10, what="the warning to come down")
    assert "Crash handler called" not in fppd.log(), fppd.tail()


def test_strings_and_panels_get_their_own_ddr_regions(fppd):
    """A twelve-string BBB48String output and an LED panel output (on PRU1
    and PRU0) get regions of the PRU DDR area that don't overlap, the cape's
    64 KB panel dataOffset notwithstanding.

    Regression: f0201910c. The outputs used hardcoded offsets: the strings'
    two buffers ran past 64 KB, where the panel cape's dataOffset started
    the panel frames, and each corrupted the other.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    octoscroller(singlePRU=True, dataOffset=64)
    fppd.write("config/channeloutputs.json", matrix_config())
    # twelve strings: two 36 KB buffers, past the panels' 64 KB dataOffset
    pins = ["P8-27", "P8-28", "P8-29", "P8-30", "P8-36", "P8-37", "P8-38", "P8-39",
            "P8-40", "P8-41", "P8-42", "P8-43"]
    write_string_cape("TestTwelve", {"outputs": [{"pin": p} for p in pins]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestTwelve", [pixel_output(n, 10, 6144 + n * 30) for n in range(12)]))
    pru.start()
    fppd.wait_for(lambda: pru.starts(0) and pru.starts(1), timeout=60, what="both outputs to start")
    s, m = ddr_region(fppd, "BBB48String"), ddr_region(fppd, "BBBMatrix")
    assert s and m, fppd.tail()
    assert s[1] <= m[0] or m[1] <= s[0], (s, m)


def test_a_pru_control_pin_is_muxed_with_a_mode_pinctrl_knows(fppd, tmp_path):
    """A panel control pin on a PRU output (the clock on P8-12, PRU0's
    r30 bit 14) is muxed with "pinctrl -s P8_12 pruout", the AM335x name
    (each pin belongs to one PRU), and the tree's own pinctrl accepts it.

    Regression: eb1e705cd. fppd passed the driver's "pru0out" through to
    pinctrl, which on the AM335x has no such mode: "Unknown mode", and the
    pin stayed a GPIO.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    p = stock_panel_pinout("Octoscroller")
    p["controls"]["clock"] = {"pin": "P8-12", "type": "pruout"}
    p["controls"]["sel0"] = {"pin": "P9-16", "type": "gpio"}
    write_panel_pinout("Octoscroller", p)
    mark = pinctrl_mark()
    fppd.write("config/channeloutputs.json", matrix_config())
    pru.start()
    calls = [c for c in pinctrl_calls(mark) if c.startswith("-s P8_12 ")]
    assert calls == ["-s P8_12 pruout"], pinctrl_calls(mark)
    from test_am335x_pinctrl import Pinmux, pinctrl
    r = pinctrl(fppd, Pinmux(tmp_path), *calls[0].split())
    assert r.returncode == 0, r.stdout


def test_short_strings_and_unused_lanes_send_zeros(fppd):
    """The frame BBB48String hands the PRU (byte lanes, one byte per string
    in turn) carries each string's data up to its own length and zeros past
    it, and zeros in the lanes no string uses: two strings of 10 and 20
    pixels lit white fill lane 0 for 30 bytes, lane 1 for 60, and nothing
    else.

    Also 8c5bfeef2 (the tiled prepData, which made the tail of a shorter
    string and the unmapped lanes zeros instead of whatever the buffer
    held): its old path is gone, so the control fills the tail with 0xFF
    instead of zeros, and the lanes carry 0xFF past the string.
    """
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    pins, _ = string_pins()
    write_string_cape("TestTwo", {"outputs": [{"pin": p} for p in pins[:2]]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestTwo", [pixel_output(0, 10, 0), pixel_output(1, 20, 30)]))
    pru.start()
    region = ddr_region(fppd, "BBB48String")
    assert region, fppd.tail()
    fppd.command("Test Start", "1000", "RGB Single Color", "1-90", "#FFFFFF")
    time.sleep(3)
    lanes = 4  # two strings round up to four lanes
    expect = bytes(0xFF if (lane == 0 and b < 30) or (lane == 1 and b < 60) else 0
                   for b in range(60) for lane in range(lanes))
    ddr = pru.ddr(region[0], region[1] - region[0])
    half = (region[1] - region[0]) // 2
    found = [off for off in range(0, half, 4096) if ddr[off:off + len(expect)] == expect]
    assert found, [ddr[o:o + 16].hex() for o in range(0, half, 4096)][:8]
    fppd.command("Test Stop")


def test_direct_row_select_builds_the_ab_addressing_firmware(fppd):
    """A matrix saved with Panel Addressing Type "Direct Row Select" (2,
    the value the page saves on a Pi and a Beagle alike) builds its
    firmware with ADDRESSING_AB, each row on its own select line; a
    Standard matrix does not.

    Regression: 285231911 (the BBBMatrix half; the BBShiftPanel half is in
    test_am62x_panels.py). BBBMatrix read the old panelAddressing key and
    took 1 for direct row select, so the page's setting never reached the
    firmware.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    octoscroller(singlePRU=True)
    cfg = matrix_config(panelRowAddressType=2)
    fppd.write("config/channeloutputs.json", cfg)
    pru.start()
    builds = matrix_builds(fppd)
    assert builds and "-DADDRESSING_AB=1" in builds[-1], builds
    # the control: Standard addressing builds without it
    cfg["channelOutputs"][0]["panelRowAddressType"] = 0
    n = len(builds)
    save(fppd, "config/channeloutputs.json", cfg)
    fppd.wait_for(lambda: len(matrix_builds(fppd)) > n, timeout=60, what="the rebuild")
    assert "-DADDRESSING_AB=1" not in matrix_builds(fppd)[-1], matrix_builds(fppd)


def test_the_matrix_hands_the_pru_each_of_its_frames_in_turn(fppd):
    """Through a test pattern the PRU is handed (address_dma) each of the
    output's four DDR frames in turn, not two of them over and over.

    Regression: 3e6bea428 (its frame ring half). After frame 0 the next
    frame was always 1, so only frames 0 and 1 were used and the one being
    shown could be the one being written: tearing.
    """
    needs_bbb()
    pru = FakePruss(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    octoscroller(singlePRU=True)
    fppd.write("config/channeloutputs.json", matrix_config())
    pru.start()
    fppd.wait_for(lambda: pru.starts(0), timeout=30, what="the panel output to start")
    region = ddr_region(fppd, "BBBMatrix")
    assert region, fppd.tail()
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    seen = set()
    try:
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            seen.add(struct.unpack("<I", pru.data_ram(0, 0, 4))[0])
            time.sleep(0.005)
    finally:
        fppd.command("Test Stop")
    assert len(seen) == 4, f"frames handed to the PRU: {sorted(hex(a) for a in seen)}"
