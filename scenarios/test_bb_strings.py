"""BBShiftString and BBB48String on an AM62x board: cape pinouts a driver
can't use, the receiver enable pin, the frame-rate budget, and a PRU that
can't be mapped. Against PRUs that never answer (see bbcape.py).

Device only: run with run-local.sh on a PocketBeagle2. Skipped elsewhere.
"""

import os
import time

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape
from fseq import write_fseq
from show import playlist, sequence_entry
import shims


def warnings_of(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def warning_info(fppd):
    return fppd.get("/fppd/status").get("warningInfo", [])


def shift_outputs(n=16):
    return [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)][:n]


def ceiling_lines(fppd):
    return [l for l in fppd.log().splitlines() if "sustainable ceiling" in l]


# ---- a cape pinout written for the other driver ------------------------------


def test_bbshiftstring_refuses_a_header_pin_pinout(fppd):
    """A BBShiftString output on a cape whose pinout names header pins (a
    BBB48String pinout, no "driver" key) is refused with a warning naming
    the driver the cape wants.

    Regression: f993d3f7c, extended by 2181fb991. The header pin name was
    read through asInt(), which threw, and all the user saw was "Could not
    initialize output type BBShiftString. (Value is not convertible to
    Int.)".
    """
    fake_pru(fppd)
    write_string_cape("TestHeaderPins", {"outputs": [{"pin": "P2-02"}, {"pin": "P2-04"}]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestHeaderPins", [pixel_output(0, 10, 0)]))
    fppd.start(timeout=60)
    w = warnings_of(fppd)
    assert any("BBShiftString: TestHeaderPins needs the BBB48String output type" in x for x in w), w
    assert not any("convertible" in x for x in w), w


def test_bbb48string_refuses_a_shift_register_pinout(fppd):
    """A BBB48String output on a cape whose pinout gives shift register
    stages (pru/pin/index) is refused with a warning naming the cape's own
    driver.

    Regression: 2181fb991. BBB48String read the integer stage through
    asString(), looked up a pin named "0", matched nothing and left every
    port silently unconfigured: no warning at all.
    """
    fake_pru(fppd)
    write_string_cape("TestShiftPins", {"driver": "BBShiftString", "outputs": shift_outputs()})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestShiftPins", [pixel_output(0, 10, 0)]))
    fppd.start(timeout=60)
    w = warnings_of(fppd)
    assert any("BBB48String: TestShiftPins needs the BBShiftString output type" in x for x in w), w


def test_bbb48string_refuses_outputs_past_the_cape_pinout(fppd):
    """A BBB48String config with more ports than the cape declares warns
    about the extra port instead of driving it.

    Regression: 2181fb991. A bare operator[] past the end of the cape's
    outputs read a null entry as pin "", and the port was dropped without a
    word.
    """
    fake_pru(fppd)
    write_string_cape("TestTwoPins", {"outputs": [{"pin": "P2-02"}, {"pin": "P2-04"}]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestTwoPins", [pixel_output(n, 5, n * 15) for n in range(3)]))
    fppd.start(timeout=60)
    w = warnings_of(fppd)
    assert any("BBB48String: output 3 is past the end of the cape's pinout" in x for x in w), w


def test_a_pinout_naming_a_pru_that_does_not_exist_is_refused(fppd):
    """A BBShiftString pinout naming pru 2 or pru -1 is refused port by
    port with a warning; the ports on pru 1 still start.

    Regression: 8de80b2e6. The pru was used unchecked as the index into
    the driver's two-entry per-PRU pin tables, reading (and later
    writing) past them.
    """
    fake_pru(fppd)
    outs = shift_outputs()
    outs[0] = {"pru": 2, "pin": 0, "index": 0}
    outs[1] = {"pru": -1, "pin": 0, "index": 1}
    write_string_cape("TestBadPru", {"driver": "BBShiftString", "outputs": outs})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestBadPru", [pixel_output(n, 5, n * 15) for n in range(3)]))
    fppd.start(timeout=60)
    w = warnings_of(fppd)
    assert any("BBShiftString: output 0 names an invalid pru" in x for x in w), w
    assert any("BBShiftString: output 1 names an invalid pru" in x for x in w), w
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(3)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.command("Test Stop")


def test_an_auto_created_model_spans_all_its_strings(fppd):
    """The overlay model auto-created for a string output's virtual strings
    named as xLights names a model's strings ("Arch-str-1", "Arch-str-2")
    covers all of them, whatever order their channels are in: here string
    2 sits below string 1.

    Regression: d92ee4a3c. The model's end was the last string's end, not
    the furthest: Arch came out 30 channels long, string 2 alone."""
    fake_pru(fppd)
    write_string_cape("TestTwoPins", {"outputs": [{"pin": "P2-02"}, {"pin": "P2-04"}]})
    first, second = pixel_output(0, 10, 30), pixel_output(1, 10, 0)
    first["virtualStrings"][0]["description"] = "Arch-str-1"
    second["virtualStrings"][0]["description"] = "Arch-str-2"
    fppd.write("config/co-bbbStrings.json", strings_config("BBB48String", "TestTwoPins", [first, second]))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.start(timeout=60)
    models = {m["Name"]: m for m in fppd.get("/overlays/models")}
    assert "Arch" in models, sorted(models)
    arch = models["Arch"]
    assert (arch["StartChannel"], arch["ChannelCount"]) == (1, 60), arch


# ---- the receiver enable pin --------------------------------------------------

PINCTRL_LOG = "/tmp/pinctrl.log"


def pinctrl_calls(since=0):
    """What fppd asked run-local.sh's stub pinctrl to do, from byte `since`."""
    try:
        with open(PINCTRL_LOG) as f:
            f.seek(since)
            return f.read().splitlines()
    except OSError:
        return []


def pinctrl_mark():
    try:
        return os.path.getsize(PINCTRL_LOG)
    except OSError:
        return 0


def listener_cape(name, outputs):
    """A shift cape that wires a Falcon V5 listener (and so the receiver
    enable line on PRU1). P1-29 is a listener pin the board has."""
    write_string_cape(name, {"driver": "BBShiftString",
                             "falconV5ListenerConfig": {"listenerPins": [{"pin": "P1-29"}]},
                             "outputs": outputs})


def test_the_receiver_enable_pin_is_muxed_for_v2_receivers(fppd):
    """On a cape whose receiver enable line is on PRU1, that pin is muxed
    to pru1out for a config with plain v2 smart receivers, not only for
    Falcon V5 ones -- it gates the whole differential bus.

    Regression: 826802ab8. The V4/V5 receiver split narrowed the condition
    to "has a V5 receiver", so any other receiver config left the pin
    unmuxed and every differential port went dark.
    """
    fake_pru(fppd)
    outs = shift_outputs()
    outs[0]["falconV5Listener"] = 0
    listener_cape("TestEnablePin", outs)
    ports = [pixel_output(n, 5, n * 15) for n in range(4)]
    for p in ports:
        p["differentialType"] = 4  # one v2 smart receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestEnablePin", ports))
    mark = pinctrl_mark()
    fppd.start(timeout=60)
    calls = pinctrl_calls(mark)
    assert "-s P2_22 pru1out" in calls, calls


# ---- frame-rate budget --------------------------------------------------------


def test_a_ucs1903_string_is_budgeted_at_its_own_bit_cell(fppd):
    """The frame time behind the "sustainable ceiling" comes from the
    protocol's bit cell: 20 ucs1903 pixels (60 bytes at ~2.6 us a bit) are
    1.6 ms a frame where the same ws2811 string is 0.9 ms.

    Regression: 5fa295bf1. The estimate charged 10 us a byte whatever the
    protocol, so a 400 kHz string's ceiling came out twice too high and
    its over-budget rates went unwarned.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    port = pixel_output(0, 20, 0)
    port["protocol"] = "ucs1903"
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift16", [port]))
    fppd.start(timeout=60)
    lines = ceiling_lines(fppd)
    assert lines and "-> 1.6ms/frame" in lines[0], lines


# Without a signed cape every port is clamped to 50 pixels, so the slowest
# string there is: 50 ucs1903 pixels, 150 bytes at ~2.6 us a bit, 3.5 ms a
# frame and a ceiling near 289 fps.
SLOW = 50


def slow_string_show(fppd, rates_s):
    """One slow string, and a playlist of sequences at each (step_ms,
    seconds) in turn."""
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    port = pixel_output(0, SLOW, 0)
    port["protocol"] = "ucs1903"
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift16", [port]))
    entries = []
    for n, (step, secs) in enumerate(rates_s):
        name = f"Rate{n}.fseq"
        frames = [bytes([(i * 7) & 0xFF]) * (SLOW * 3) for i in range(secs * 1000 // step)]
        write_fseq(os.path.join(fppd.media, "sequences", name), frames, step_ms=step)
        entries.append(sequence_entry(name))
    fppd.write("playlists/Rates.json", playlist("Rates", entries))


def budget_warnings(fppd):
    return [w for w in warning_info(fppd)
            if w.get("message", "").startswith("Sequence frame rate (")]


def test_an_over_budget_rate_is_warned_as_soon_as_it_plays_and_retracted_after(fppd):
    """A 500 fps sequence on a string that can do ~289 fps raises warning 63
    naming both rates within seconds of starting, and the 100 fps sequence
    after it in the same playlist takes it down again.

    Regression: 793922c03. The only warning was the measured one, after a
    minute of dropped frames; a rate that rose mid-playlist (the output
    thread never restarts between entries) was never predicted at all.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    slow_string_show(fppd, ((2, 10), (10, 10)))
    fppd.start(timeout=60)
    fppd.command("Start Playlist", "Rates", "false", "false")
    found = fppd.wait_for(lambda: budget_warnings(fppd), timeout=6, interval=0.5,
                          what="the frame-rate budget warning")
    assert [w.get("id") for w in found] == [63], found
    assert "(500 fps)" in found[0]["message"] and "(~289" in found[0]["message"], found

    def on_second():
        return "Rate1" in fppd.get("/fppd/status").get("current_sequence", "")

    fppd.wait_for(on_second, timeout=30, interval=0.5, what="the 100 fps sequence")
    fppd.wait_for(lambda: not budget_warnings(fppd), timeout=5, interval=0.5,
                  what="the warning to come down")
    fppd.command("Stop Now")


def test_the_frames_dropped_warning_comes_down_when_its_output_goes(fppd):
    """Once the back-pressure gate's "frames are being dropped" warning is
    up, saving a config without that output takes it down: the output that
    raised it retracts it as it closes.

    Regression: b117708ae. The flag behind the warning was a function
    static, never cleared on Close(), so a reconfigured or removed output
    left the warning on screen until fppd restarted.
    """
    fake_pru(fppd)
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    cfg = strings_config("BBShiftString", "TestShift16", [pixel_output(0, 20, 0)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")

    def dropped():
        return [w for w in warning_info(fppd) if "frames are being dropped" in w.get("message", "")]

    fppd.wait_for(dropped, timeout=100, interval=2, what="the frames-dropped warning")
    fppd.command("Test Stop")
    cfg["channelOutputs"][0]["enabled"] = 0
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))
    fppd.wait_for(lambda: not dropped(), timeout=30, interval=1, what="the warning to come down")


def test_falcon_v5_queries_are_charged_to_the_frame_budget(fppd):
    """With Falcon V5 chains, the queries' share of the frames is added to
    the frame time behind the frame-rate ceiling (and its warning): about
    2.9 ms a query frame on top of the string data.

    Regression: a0f028072 (the budget half; the complete-capture half needs
    a real receiver). The frame time was the string data plus a flat
    1700 us, so a config whose data fit but whose queries did not dropped
    frames with no warning.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    outs = shift_outputs()
    for n in range(0, 16, 4):
        outs[n]["falconV5Listener"] = n // 4
    listener_cape("TestShiftV5", outs)
    ports = [pixel_output(n, 50, n * 150) for n in range(4)]
    for p in ports:
        p["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShiftV5", ports))
    fppd.start(timeout=60)
    base = ceiling_lines(fppd)
    queries = [l for l in base if "FalconV5 queries on" in l]
    assert queries, base

    def ms(line):
        return float(line.split("-> ")[1].split("ms/frame")[0])

    share = float(queries[0].split("queries on ")[1].split("%")[0]) / 100
    assert share > 0, queries
    assert abs(ms(queries[0]) - ms(base[0]) - 2.9 * share) < 0.1, base


# ---- PRU memory that can't be mapped ------------------------------------------


def test_pru_memory_that_cannot_be_mapped_fails_the_output_cleanly(fppd):
    """When the PRU memory mapping fails (as it does once fppd is out of
    file descriptors), the string output is refused with the loader's
    warning and fppd carries on.

    Regression: 845700732. initPrus() checked no mmap() result and
    memset() the PRU's data RAM through MAP_FAILED: SIGSEGV at startup.
    Here a shim fails the PRUSS-sized anonymous mapping FAKE_PRU mode makes.
    """
    fake_pru(fppd)
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift16", [pixel_output(0, 20, 0)]))
    so = shims.build("co_failprumap.c")
    fppd.start(timeout=60, preload=[so], extra_env={"CO_FAILPRUMAP_LEN": str(0x80000)})
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    w = warnings_of(fppd)
    assert any("Could not initialize output type BBShiftString" in x and "could not map PRU memory" in x
               for x in w), w
