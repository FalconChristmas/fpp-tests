"""BeagleBone PRU outputs (BBShiftPanel, BBShiftString, BBB48String) on an
AM62x board, against PRUs that never answer (see bbcape.py).

Device only: run with run-local.sh on a PocketBeagle2 (the panel cases need a
cape whose EEPROM carries a "PocketScroller" panel config). The GPIO lines are
the real ones, so stop the device's own fppd first. Skipped elsewhere.
"""

import os
import time

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape


def panel_config(**over):
    """One 64x32 1/16 scan panel on output 1 of the cape's panel config."""
    c = {"cfgVersion": 3, "type": "LEDPanelMatrix", "subType": "BBShiftPanel",
         "configName": "PocketScroller", "enabled": 1, "startChannel": 1, "channelCount": 6144,
         "ledPanelsWidth": 64, "ledPanelsHeight": 32, "ledPanelsScan": 16, "panelWidth": 64,
         "panelHeight": 32, "panelScan": 16, "ledPanelsSize": "64x32x16", "colorOrder": "RGB",
         "gamma": "2.2", "brightness": 10, "ledPanelsLayout": "1x1", "ledPanelsOutputs": 16,
         "ledPanelsPanelsPerOutput": 16, "panelColorDepth": 8, "invertedData": 0,
         "panelOutputOrder": False, "panelOutputBlankRow": False, "panelRowAddressType": 0,
         "panelType": 0, "panelInterleave": "0", "panelDataLayout": 0,
         "panels": [{"outputNumber": 0, "panelNumber": 0, "colorOrder": "", "xOffset": 0,
                     "yOffset": 0, "orientation": "N", "row": 0, "col": 0}]}
    c.update(over)
    return {"channelOutputs": [c]}


DP3364 = 6  # panelType: a PWM panel whose registers go up one word per PRU command


def test_a_pwm_panel_whose_pru_never_answers_does_not_hang_startup(fppd):
    """A PWM panel (DP3364) on a PRU that never takes a command: fppd still
    finishes starting and answers, with the output's registers unsent.

    Regression: c12f35186. setupPWMRegisters() waited for the PRU to take
    each register word with no time limit, on the main loop during output
    setup, so fppd never finished starting.

    The output is refused (see the next scenario), so fppd also stops
    cleanly here.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/channeloutputs.json", panel_config(panelType=DP3364))
    fppd.start(timeout=60)
    assert fppd.get("/fppd/status").get("fppd") == "running"
    assert "PWM panel registers were not sent" in fppd.log()


FM6363C = 3  # panelType: a PWM panel whose registers go up in one command


def test_a_pwm_panel_on_a_pru_that_never_answers_keeps_fppd_responsive(fppd):
    """A PWM panel (FM6363C) on a PRU that never takes a command is not
    started, so the output thread, a reload of the outputs and shutdown all
    carry on.

    Regression: 721882691. c12f35186 let Init() return when the PRU didn't
    take the registers, but the output was still started; its first
    PrepData then waited forever for the PRU, holding outputThreadLock, and
    on SIGTERM fppd never exited (StopChannelOutputThread gave up after
    5 s).
    """
    fake_pru(fppd)
    fppd.write("config/channeloutputs.json", panel_config(panelType=FM6363C))
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(2)
    # A reload of the outputs, as an xLights upload does.
    tmp = fppd.write("config/channeloutputs.json.new", panel_config(panelType=DP3364))
    os.replace(tmp, os.path.join(fppd.media, "config", "channeloutputs.json"))
    time.sleep(3)
    for _ in range(5):
        fppd.get("/fppd/status", timeout=5)
        time.sleep(1)
    fppd.command("Test Stop", timeout=5)
    # The fixture then checks that fppd exits 0 on SIGTERM.


def shift_cape(name):
    """A shift-register string cape: 16 outputs on two PRU1 data pins."""
    write_string_cape(name, {"driver": "BBShiftString", "outputs": [
        {"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]})


def test_an_output_test_type_with_no_string_tester(fppd):
    """The Output Specific test with a type no string tester implements (8)
    runs BBShiftString's normal data instead of crashing.

    Regression: a09f89deb. getPixelStringTester(8) returns null and
    prepData called prepareTestData() on it: SIGSEGV on the output thread
    on the first frame of the test.
    """
    fake_pru(fppd)
    shift_cape("TestShift16")
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift16", [pixel_output(0, 20, 0), pixel_output(1, 20, 60)]))
    status = fppd.start(timeout=60)
    assert not any("BBShiftString" in w for w in status.get("warnings", [])), status
    fppd.command("Test Start", "500", "Output Specific", "--ALL--", "8")
    # The output thread went idle after startup; the main loop restarts it
    # for the test a few seconds later.
    time.sleep(6)
    # fppd's crash handler keeps the process (and its API) up for a while
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.get("/fppd/status")
    fppd.command("Test Stop")


def test_a_full_height_panel_with_interleave_off_starts(fppd):
    """A full height panel (64x64, every row its own address) saved with the
    interleave the UI hides but still saves ("0", Off) starts.

    Regression: f3c5c1c1c. parsePanelParams() dropped the full height
    layout as "combined with interleave", and the standard layout it fell
    back to has no interleave handler for scan == height, so the output was
    refused.
    """
    fake_pru(fppd)
    fppd.write("config/channeloutputs.json", panel_config(
        ledPanelsHeight=64, panelHeight=64, ledPanelsScan=64, panelScan=64,
        ledPanelsSize="64x64x64", channelCount=12288, panelInterleave="0", panelDataLayout=1))
    status = fppd.start(timeout=60)
    assert not any("BBShiftPanel" in w for w in status.get("warnings", [])), status
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(6)
    assert "Crash handler called" not in fppd.log(), fppd.tail()
    fppd.command("Test Stop")


def test_a_falcon_v5_listener_pin_the_board_lacks_fails_the_output(fppd):
    """A cape config whose Falcon V5 listener pin this board doesn't have
    refuses the output, with the pin named, instead of crashing fppd.

    Regression: 0b8c9009e. The missing pin came back null and was
    dereferenced in the output's Init(): SIGSEGV at startup.
    """
    fake_pru(fppd)
    write_string_cape("TestShiftV5", {
        "driver": "BBShiftString",
        "falconV5ListenerConfig": {"listenerPins": [{"pin": "P9-99"}]},
        "outputs": [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]})
    outputs = [pixel_output(0, 20, 0), pixel_output(1, 20, 60)]
    outputs[0]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShiftV5", outputs))
    status = fppd.start(timeout=60)
    text = " ".join(status.get("warnings", [])) + fppd.log()
    assert "P9-99' does not exist on this board" in text, fppd.tail()


def test_more_than_48_outputs_on_one_pru_is_refused(fppd):
    """A BBB48String config using 49 outputs on one PRU is refused: the
    firmware has room for 48.

    Regression: 235db2c70. Nothing limited the count; past 48 the
    firmware's per-output loads run into its GPIO address registers.
    """
    fake_pru(fppd)
    write_string_cape("Test49", {"driver": "BBB48String",
                                 "outputs": [{"pin": "P2-02"} for _ in range(49)]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "Test49", [pixel_output(n, 1, n * 3) for n in range(49)]))
    status = fppd.start(timeout=60)
    assert any("more than 48 outputs on one PRU" in w for w in status.get("warnings", [])), status



def save_strings(fppd, cfg):
    """Save co-bbbStrings.json the way the UI does, in one rename, so fppd
    reloads it once."""
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))


def warnings_of(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def test_a_bbb48string_config_warning_comes_down_when_the_config_is_fixed(fppd):
    """The "more than 48 outputs" refusal is up while the config asks for
    49, and comes down when a config that fits is saved -- with no restart.

    Regression: dbc4a571c. BBB48String raised its config warnings with a
    plain AddWarning(), which an output reload never retracts, so the
    banner stayed over the working output until fppd restarted.
    """
    fake_pru(fppd)
    write_string_cape("Test49", {"driver": "BBB48String",
                                 "outputs": [{"pin": "P2-02"} for _ in range(49)]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "Test49", [pixel_output(n, 1, n * 3) for n in range(49)]))
    fppd.start(timeout=60)
    assert any("more than 48 outputs" in w for w in warnings_of(fppd)), warnings_of(fppd)
    save_strings(fppd, strings_config("BBB48String", "Test49", [pixel_output(0, 10, 0)]))
    fppd.wait_for(lambda: not any("more than 48 outputs" in w for w in warnings_of(fppd)),
                  timeout=30, what="the warning to come down")


def test_a_bbshiftstring_config_warning_comes_down_when_the_config_is_fixed(fppd):
    """A BBShiftString config with a port past the cape's pinout warns, and
    the warning comes down when a config within the pinout is saved.

    Regression: dbc4a571c. BBShiftString raised its config warnings with a
    plain AddWarning(), which an output reload never retracts.
    """
    fake_pru(fppd)
    write_string_cape("TestShift2", {"driver": "BBShiftString", "outputs": [
        {"pru": 1, "pin": 0, "index": i} for i in range(2)]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift2", [pixel_output(n, 5, n * 15) for n in range(3)]))
    fppd.start(timeout=60)

    def past():
        return [w for w in warnings_of(fppd) if "past the end of the cape's pinout" in w]

    assert past(), warnings_of(fppd)
    save_strings(fppd, strings_config("BBShiftString", "TestShift2",
                                      [pixel_output(n, 5, n * 15) for n in range(2)]))
    fppd.wait_for(lambda: not past(), timeout=30, what="the warning to come down")


def test_the_frame_rate_ceiling_without_a_receiver(fppd):
    """Without a Falcon receiver, BBShiftString's frame time estimate is the
    string data plus the firmware's 300 us reset: 20 px (60 bytes) at
    1250 ns/bit is 0.9 ms a frame.

    Regression: 4ff3ce44a. A flat 1700 us (measured with a receiver's
    packet phase) was charged to every frame: 2.3 ms here, and a 300 px
    port was warned about at 100 fps that runs at 110.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    shift_cape("TestShift16")
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift16", [pixel_output(0, 20, 0)]))
    fppd.start(timeout=60)
    lines = [l for l in fppd.log().splitlines() if "sustainable ceiling" in l]
    assert lines and "-> 0.9ms/frame" in lines[0], lines


def test_receiver_blocks_each_get_their_own_place_on_the_monitor(fppd):
    """Three 4-port smart receiver blocks on a cape with no monitored local
    ports get distinct places on the current monitor, from row 1, and a
    config reload doesn't add ports.

    Regression: e831efc3f. Every block after the first took its column from
    its own unplaced slot and landed on the same row at columns 5-8, and
    the first block started on row 0, which the page never draws.
    """
    fake_pru(fppd)
    outs = []
    for p in range(2):
        for i in range(8):
            o = {"pru": 1, "pin": p, "index": i}
            if (p * 8 + i) % 4 == 0 and p * 8 + i < 12:
                o["falconV5Listener"] = (p * 8 + i) // 4
            outs.append(o)
    write_string_cape("TestShiftBlocks", {"driver": "BBShiftString", "outputs": outs})
    cfg = strings_config("BBShiftString", "TestShiftBlocks",
                         [pixel_output(n, 1, n * 3) for n in range(12)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)

    def placed():
        ports = [p for p in fppd.get("/fppd/ports") if p.get("name", "").startswith("Port ")]
        return {p["name"]: (p.get("row"), p.get("col")) for p in ports}

    where = placed()
    blocks = [where.get(f"Port {n + 1}") for n in range(12)]
    assert all(b is not None and b[0] is not None for b in blocks), where
    assert min(b[0] for b in blocks) >= 1, where
    assert len(set(blocks)) == 12, where
    before = len(fppd.get("/fppd/ports"))
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))
    time.sleep(5)
    assert len(fppd.get("/fppd/ports")) == before
    assert placed() == where


def test_the_frames_dropped_warning_is_filed_as_a_frame_rate_warning(fppd):
    """When BBShiftString's back-pressure gate drops frames for a minute
    (here, a PRU that never takes them), the warning is raised under id 63,
    "Frame Rate Too High For Pixel Strings".

    Regression: 448e6f775. It was raised as 61, "Command Not Found".
    """
    fake_pru(fppd)
    shift_cape("TestShift16")
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift16", [pixel_output(0, 20, 0)]))
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")

    def dropped():
        info = fppd.get("/fppd/status").get("warningInfo", [])
        return [w for w in info if "frames are being dropped" in w.get("message", "")]

    found = fppd.wait_for(dropped, timeout=100, interval=2, what="the frames-dropped warning")
    assert [w.get("id") for w in found] == [63], found
    fppd.command("Test Stop")

