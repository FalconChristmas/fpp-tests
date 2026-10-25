"""Timed behaviour across a wall-clock step.

NTP corrections, GPS fixes and cape RTCs that boot years in the past all
step fppd's wall clock while it runs. Anything fppd times -- a delay, a
period, a deadline -- has to run on the monotonic clock, or a step back
holds it for the size of the step and a step forward fires it early.
(Frame output across a step: test_output_clock.py; test patterns:
test_channel_tester.py.)
"""

import time

import pytest

STEPS = {"back an hour": "2026-12-24 17:00:01", "forward an hour": "2026-12-24 19:00:01"}


def variable(fppd, name):
    # /variables is null until the first variable exists
    return (fppd.get("/variables", timeout=5) or {}).get(name, {}).get("value")


def set_variable_preset(name, var, value):
    return {"name": name, "command": "Set Variable",
            "args": [var, "Value", value, "1", "0", "100", ""], "presetSlot": 0}


def fppd_clock(fppd):
    """fppd's (faked) local wall clock, to the second, from its status."""
    import datetime
    words = fppd.get("/fppd/status")["time"].split()  # "Thu Dec 24 17:00:01 EST 2026"
    return datetime.datetime.strptime(" ".join(words[:4] + words[5:]), "%a %b %d %H:%M:%S %Y")


@pytest.mark.parametrize("tz", [None, "America/New_York"])
def test_set_clock_lands_on_the_time_asked_for(fppd, tz):
    """The harness itself: fppd.set_clock() puts fppd's clock where it was
    asked to, however long fppd has run, in fppd's own zone, and asking for
    the same time twice steps it back there again. It used to subtract the
    run time from an "@" start time that libfaketime restarts on every
    change, so each step landed short by the seconds fppd had been up."""
    import datetime
    fppd.start(fake_time="2026-12-24 18:00:00", tz=tz)
    for when in ("2026-12-24 17:00:01", "2026-12-24 19:30:00", "2026-12-24 19:30:00"):
        time.sleep(4)
        fppd.set_clock(when)
        got = fppd_clock(fppd)
        want = datetime.datetime.strptime(when, "%Y-%m-%d %H:%M:%S")
        # A second either way. Each target is a whole second and fppd reports
        # whole seconds, so landing any fraction short reads as a full second
        # short -- the nightly once read 19:29:59 for 19:30:00, a shortfall
        # the offset arithmetic doesn't explain and the runner's own clock
        # being adjusted mid-step would. The bug this guards against landed
        # short by fppd's run time, at least the 4 s slept before each step.
        assert abs(got - want) <= datetime.timedelta(seconds=1), \
            f"asked for {when}, fppd reads {got}"


@pytest.mark.parametrize("step", list(STEPS))
def test_preset_in_future_fires_on_time_across_a_clock_step(fppd, step):
    """"Trigger Command Preset In Future" with 3 s fires about 3 s later even
    though the wall clock steps an hour in between.

    Regression: fppd's Timers kept every deadline on the wall clock, so a
    step back held this preset (and recurring tasks, If chains, the media
    slot pump, ...) for an hour, and a step forward fired it at once.
    Fixed by aaaa005ae.
    """
    fppd.write("config/commandPresets.json", {"commands": [set_variable_preset("P", "Fired", "yes")]})
    fppd.start(fake_time="2026-12-24 18:00:00")

    t0 = time.monotonic()
    fppd.command("Trigger Command Preset In Future", "t", "3000", "P")
    time.sleep(1)
    fppd.set_clock(STEPS[step])
    time.sleep(0.5)
    assert variable(fppd, "Fired") is None, f"the preset fired early, right after the clock stepped {step}"
    fppd.wait_for(lambda: variable(fppd, "Fired") == "yes", timeout=6, interval=0.1,
                  what=f"the preset to fire after the clock stepped {step}")
    took = time.monotonic() - t0
    assert 2.5 <= took <= 4.5, f"a 3 s preset fired after {took:.1f} s"


def overlay_frames_keep_changing(fppd, rx, step, what):
    """Distinct frames on the wire in the 2 s after the clock steps."""
    fppd.set_clock(STEPS[step])
    time.sleep(0.5)
    since = time.monotonic()
    time.sleep(2)
    seen = {f for _, f in rx.snapshot(since)}
    assert len(seen) >= 5, f"{what} stopped moving after the clock stepped {step}: {len(seen)} distinct frame(s)"


@pytest.mark.parametrize("step", list(STEPS))
def test_overlay_effect_keeps_running_across_a_clock_step(fppd, step):
    """A running overlay effect (Bars, moving) keeps animating when the wall
    clock steps.

    Regression: the overlay effect thread scheduled every effect update on
    the wall clock: a step back froze all running effects for the size of
    the step, a step forward ran an hour of updates back to back (no
    frames at all meanwhile). Fixed by da4268fef.
    """
    from ddp import DdpReceiver
    from test_overlays import CHANNELS, effect, matrix, setup
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(fake_time="2026-12-24 18:00:00")
        # 30 sweeps in 60 s: the default speed (one in 2 s), but still
        # running when the 2 s window after the step ends.
        effect(fppd, "M", "Bars", Direction="Down", time="60000", iterations="30")
        assert rx.wait_frames(20, timeout=10), "the Bars effect never reached the wire"
        overlay_frames_keep_changing(fppd, rx, step, "the Bars effect")


@pytest.mark.parametrize("step", list(STEPS))
def test_wled_effect_keeps_running_across_a_clock_step(fppd, step):
    """A WLED overlay effect keeps animating when the wall clock steps
    (WLED's own millis() was the wall clock, a second path to the same
    freeze; the forward step passes either way). Fixed by da4268fef."""
    from ddp import DdpReceiver
    from test_overlays import CHANNELS, effect, matrix, setup
    setup(fppd, [matrix()])
    with DdpReceiver(CHANNELS) as rx:
        fppd.start(fake_time="2026-12-24 18:00:00")
        names = fppd.get("/overlays/effects")
        wled = [n for n in names if "Rainbow" in n and n.startswith("WLED")]
        assert wled, f"no WLED rainbow effect among {names}"
        effect(fppd, "M", wled[0])
        assert rx.wait_frames(20, timeout=10), "the WLED effect never reached the wire"
        overlay_frames_keep_changing(fppd, rx, step, f"the {wled[0]} effect")


def test_bridge_backup_source_takes_over_across_a_clock_step(fppd):
    """With BridgeSourcePriority on, when the higher-priority E1.31 source
    stops, the lower one takes over after the input timeout -- even if the
    wall clock steps back in between.

    Regression: the active source's age was measured on the packets'
    wall-clock time, so after a step back the stopped source stayed
    "active" for an hour and the output froze on its last frame. Fixed by
    9ad947f0c.
    """
    from packets import E131_PORT, Sender, e131
    from test_bridge_inputs import (E131_SIZE, E131_START, OUT_PORT, Listener, region,
                                    setup, wait_output)
    setup(fppd)
    fppd.settings(BridgeSourcePriority="1")
    hi = bytes([0xAA]) * E131_SIZE
    lo = bytes([0x55]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start(fake_time="2026-12-24 18:00:00")
        with Sender(lambda n: [(e131(10, lo, seq=n, priority=50, cid=b"source-low"), E131_PORT)]):
            with Sender(lambda n: [(e131(10, hi, seq=n, priority=150, cid=b"source-high"), E131_PORT)]):
                wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == hi,
                            "the higher-priority source")
            fppd.set_clock("2026-12-24 17:00:00")
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == lo,
                        "the backup source to take over after the clock stepped back", timeout=6)


@pytest.mark.parametrize("step", list(STEPS))
def test_play_media_plays_through_a_clock_step(fppd, audio, step):
    """Play Media plays the whole file and ends, leaving the player idle,
    when the wall clock steps part-way through.

    Coverage, not a red-before test: GStreamer's stall and preroll
    watchdogs and the media slot pump measured on the wall clock (moved to
    the monotonic one by 800d8a609), but this passes on the earlier code too --
    the watchdogs only misfire if the step lands while their timer is
    armed, which this can't arrange.
    """
    import os
    from audio import write_tone_wav
    from test_media import sounding
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 5, freq=1000, amplitude=0.5)
    fppd.start(fake_time="2026-12-24 18:00:00")
    rec = audio.record()
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    time.sleep(1.5)
    fppd.set_clock(STEPS[step])
    # Recorded until the player is idle, not for a fixed time: under
    # libfaketime the stream can take a few seconds to start in a container
    # (measured 3.5 s, against 0.8 s on the real clock -- with no step at all).
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle", timeout=15,
                  what=f"the player to go idle after the media, the clock having stepped {step}")
    time.sleep(0.5)
    samples = rec.stop()
    first, last = sounding(samples)
    assert first is not None, "nothing was heard"
    assert last - first >= 4.6, f"heard {last - first:.2f} s of a 5 s file across the clock step"


def test_a_stalled_track_survives_a_clock_step_back(fppd, audio):
    """Play Media whose position has stopped moving (PipeWire stopped for a
    moment, which arms GStreamer's stall watchdog), and the wall clock steps
    back an hour while it is armed: once PipeWire runs again the track plays
    on to its end; it is not stopped as stalled. (A video, to a video group
    with an overlay member: its sound has a pipewiresink of its own, which
    stops with PipeWire, where an audio file's goes through the slot's
    shared output stream.)

    Regression: 800d8a609. The stall watchdog and the stream slot pump that
    runs it measured on the wall clock, in unsigned arithmetic. Before it,
    the track never ended: after the step back the pump waited out the hour,
    and had it run, the armed watchdog's "now - start" wrapped to a huge
    value and stopped the track as stalled."""
    import os
    import re
    import signal
    from test_media import sounding
    if os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("stops the scenario's own PipeWire; under --host-audio that is the device's")
    from test_video import MODEL, make_video, overlay_consumer, setup
    make_video(os.path.join(fppd.media, "videos", "Eight.mkv"), seconds=8)
    setup(fppd, [overlay_consumer()])
    fppd.settings(LogLevel_MediaOut="debug")
    fppd.start(fake_time="2026-12-24 18:00:00")
    fppd.command("Play Media", "Eight.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"], timeout=15,
                  interval=0.1, what="the video to be playing")
    time.sleep(1.5)
    rec = audio.record()
    daemon = audio.procs[0]
    seen = len(fppd.log())

    def armed():
        return [float(m) for m in re.findall(r"position stalled at ([0-9.]+)s, starting watchdog",
                                             fppd.log()[seen:]) if float(m) > 0.5]
    os.kill(daemon.pid, signal.SIGSTOP)
    try:
        fppd.wait_for(armed, timeout=4, interval=0.05,
                      what="the stall watchdog to arm mid-track (precondition: the position stops with PipeWire)")
        fppd.set_clock("2026-12-24 17:00:01")
        time.sleep(0.5)
    finally:
        os.kill(daemon.pid, signal.SIGCONT)
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle", timeout=20,
                  what="the player to go idle after the media")
    time.sleep(0.5)
    samples = rec.stop()
    stalled = [l for l in fppd.log().splitlines() if "Stopping playback" in l]
    assert not stalled, "the clock step stopped the track as stalled:\n" + "\n".join(stalled)
    first, last = sounding(samples, threshold=0.03)  # the video's tone is quiet
    assert first is not None and last - first >= 4, \
        f"heard {0 if first is None else last - first:.1f} s of the last 6 s of the track"


def test_controller_that_returns_after_a_clock_step_gets_the_show(fppd):
    """A controller that dropped out (and was taken off the output after its
    pings failed) is put back once it answers again, though the wall clock
    stepped back in between. (Pings every 15 s: this takes a minute or two.)

    Regression: the ping manager timed its periodic pings and their
    timeouts on the wall clock, so after a step back it stopped pinging for
    the size of the step and the returning controller stayed dark. Fixed by
    0f2c420cd.
    """
    import subprocess

    from ddp import DdpReceiver
    from fseq import unique_frames
    from show import CHANNELS, ddp_output, install

    address = "10.77.0.2"  # nothing answers here until the test adds it

    def host_warnings():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", []) if w.get("id") == 27]

    frames = unique_frames(6000, CHANNELS)  # 300 s, longer than the test
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        config = ddp_output(CHANNELS, address=address)
        config["channelOutputs"][0]["universes"][0]["monitor"] = 1
        fppd.write("config/co-universes.json", config)
        fppd.start(fake_time="2026-12-24 18:00:00")
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(host_warnings, timeout=120, interval=1,
                      what="fppd to give up on the unreachable controller")
        fppd.set_clock("2026-12-24 17:00:00")
        time.sleep(1)
        try:
            subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], check=True)
            up = time.monotonic()
            assert rx.wait_frames(20, timeout=60, since=up), \
                "the controller came back after a clock step but fppd never sent it anything"
        finally:
            subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"])


def test_lor_heartbeat_keeps_going_across_a_clock_step(fppd):
    """A LOR output keeps sending its heartbeat (00 FF 81 56) to the
    controllers when the wall clock steps back; without it they drop out of
    show mode.

    Regression: the heartbeat thread compared wall-clock microseconds, so a
    step back stopped it for the size of the step. Fixed by 5bd4425b1.
    """
    from serial import PtyReader
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOR", "enabled": 1, "startChannel": 1, "channelCount": 16,
            "device": pty.device, "speed": 19200, "firstControllerId": 1,
        }]})
        fppd.start(fake_time="2026-12-24 18:00:00")

        def heartbeats():
            return sum(1 for m in pty.messages() if m == b"\xff\x81\x56")

        fppd.wait_for(lambda: heartbeats() >= 2, what="the LOR heartbeat")
        fppd.set_clock("2026-12-24 17:00:00")
        time.sleep(0.5)
        before = heartbeats()
        time.sleep(3)
        sent = heartbeats() - before
        assert sent >= 3, f"{sent} LOR heartbeats in the 3 s after the clock stepped back"


@pytest.mark.parametrize("step", list(STEPS))
def test_uptime_survives_a_clock_step(fppd, step):
    """fppd's uptime (in /fppd/status and the fpp_uptime_seconds variable)
    keeps counting from start-up through a wall-clock step.

    Regression: both were "now - start" on the wall clock, so a step back
    made the uptime negative and a step forward added the hour. Fixed by
    d0ca69df0.
    """
    fppd.start(fake_time="2026-12-24 18:00:00")
    time.sleep(2)
    fppd.set_clock(STEPS[step])
    time.sleep(1)
    total = fppd.get("/fppd/status").get("uptimeTotalSeconds")
    assert total is not None and 2 <= int(total) <= 30, f"uptime {total} s after about 3 s"
    # fpp_* variables are read through expressions, as an If condition does
    fppd.command("Set Variable", "Up", "Expression", "", "1", "0", "100", "=fpp_uptime_seconds")
    var = int(float(variable(fppd, "Up")))
    assert 2 <= var <= 30, f"fpp_uptime_seconds {var} after about 3 s"


def test_mqtt_status_keeps_publishing_across_a_clock_step(fppd):
    """The periodic MQTT status publish (MQTTStatusFrequency) carries on
    after the wall clock steps back.

    Regression: the publish thread compared the next publish time with the
    wall clock, so a step back stopped every periodic publish (playlist,
    fppd and port status) for the size of the step. Fixed by 4711cf9d7.
    """
    import shutil
    import subprocess
    if not shutil.which("mosquitto") or not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto and mosquitto_sub are not installed")
    port = "18830"
    broker = subprocess.Popen(["mosquitto", "-p", port], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sub = None
    try:
        time.sleep(0.5)
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", port, "-t", "#", "-v"],
                               stdout=subprocess.PIPE, text=True)
        fppd.settings(MQTTHost="127.0.0.1", MQTTPort=port, MQTTStatusFrequency="1")
        fppd.start(fake_time="2026-12-24 18:00:00")
        time.sleep(3)
        fppd.set_clock("2026-12-24 17:00:00")
        time.sleep(4.5)
    finally:
        if sub:
            sub.terminate()
        broker.terminate()
    out = sub.communicate(timeout=5)[0] if sub else ""
    statuses = [l for l in out.splitlines() if l.split(" ", 1)[0].endswith("/fppd_status")]
    # once a second for about 7.5 s, less the time to connect: 2-3 before
    # the step and 4 after
    assert len(statuses) >= 4, \
        f"{len(statuses)} fppd_status publishes in 7.5 s: they stopped after the clock stepped back"


def test_virtual_display_keeps_streaming_across_a_clock_step(fppd):
    """The HTTP virtual display (the browser preview) keeps sending frames of
    a playing sequence when the wall clock steps back.

    Regression: 2c36c564e. Its send pacing waited until the wall clock
    reached the next send time, so a step back froze the preview for the
    size of the step."""
    from fseq import unique_frames
    from show import install
    from test_output_config import sse_messages, virtual_display, wait_for_display
    install(fppd, unique_frames(2400, 9))  # 120 s
    virtual_display(fppd, ["10,10", "5,5,3,3,RGB"], 9)
    fppd.start(fake_time="2026-12-24 18:00:00")
    wait_for_display(fppd)
    fppd.command("Start Playlist", "Show", "false", "false")
    assert len(sse_messages(2)) >= 5, "the display streamed nothing before the clock step"
    fppd.set_clock("2026-12-24 17:00:01")
    time.sleep(0.5)
    sent = len(sse_messages(2))
    assert sent >= 5, f"{sent} frames streamed in the 2 s after the clock stepped back"


def test_script_entry_elapsed_time_across_a_clock_step(fppd):
    """A running script playlist entry reports the time it has been running
    in /fppd/status, through a wall-clock step back.

    Regression: 2c36c564e. Its elapsed time was the wall clock less its start,
    so a step back made it an hour negative (and its config's
    secondsElapsed, unsigned, about 1.8e19)."""
    import os
    path = fppd.write("scripts/wait.sh", "#!/bin/sh\nsleep 60\n")
    os.chmod(path, 0o755)
    fppd.write("playlists/Wait.json", {"name": "Wait", "repeat": 0, "loopCount": 0, "leadIn": [],
                                       "mainPlaylist": [{"type": "script", "enabled": 1, "playOnce": 0,
                                                         "scriptName": "wait.sh", "scriptArgs": "",
                                                         "blocking": True}],
                                       "leadOut": []})
    fppd.start(fake_time="2026-12-24 18:00:00")
    fppd.command("Start Playlist", "Wait", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("current_sequence") == "wait.sh",
                  what="the script entry to run")
    time.sleep(1)
    fppd.set_clock("2026-12-24 17:00:01")
    time.sleep(1)
    elapsed = int(fppd.get("/fppd/status").get("seconds_elapsed"))
    try:
        assert 0 <= elapsed < 120, f"the script entry reports {elapsed} s elapsed after about 2 s"
    finally:
        fppd.command("Stop Now")
