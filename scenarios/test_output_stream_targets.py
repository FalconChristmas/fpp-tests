"""The slot's persistent PipeWire output stream (PipeWireOutputStream) moving
between sinks: a track started for a different sink than the stream is open
on has to reach that sink. The sinks are null sinks on the audio fixture's
PipeWire; what each one plays is recorded from its monitor."""

import os
import time

import shims
from audio import Recording, rms_windows, write_tone_wav
from test_audio_backends import add_sink
from test_command_socket import send
from test_media_commands import slot_status


def test_a_track_for_another_sink_plays_there_when_the_stream_is_open(fppd, audio):
    """With the output kept open (PipeWireKeepOutputOpen) on sink X after a
    track, PipeWireSinkName is switched to sink Y and a 4 s tone is played
    while the stream's worker is slow to react (pwstream_slowworker.c holds
    it 1 s, as a loaded single-core box does): Y hears the tone for most of
    its length.

    Regression: 66dd9583d. WaitReady() took the stream Ready on X for
    ready, so the track went to PLAYING at once; the worker then closed the
    stream to reopen it on Y, and CloseLocked() dropped the track's feed
    with it: the whole track played silent. Not covered: the other half,
    a failed open's state answering the next track's wait at once while the
    stream is reopened (the head of the track lost)."""
    x, y = "fpp_test_x", "fpp_test_y"
    add_sink(audio, x, ["FL", "FR"])
    add_sink(audio, y, ["FL", "FR"])
    write_tone_wav(os.path.join(fppd.media, "music", "A.wav"), 2)
    write_tone_wav(os.path.join(fppd.media, "music", "B.wav"), 4)
    fppd.settings(PipeWireSinkName=x, PipeWireKeepOutputOpen="1")
    arm = os.path.join(fppd.media, "tmp", "arm")
    fppd.start(preload=[shims.build("pwstream_slowworker.c", libs=("-ldl", "-lpthread"))],
               extra_env={"SLOWWORKER_ARM": arm, "SLOWWORKER_MS": "1000"})
    fppd.command("Play Media", "A.wav", "1", "0", "1")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") == "playing", timeout=10,
                  what="A.wav to play on X")
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") != "playing", timeout=10,
                  what="A.wav to finish")
    send(f"SetSetting,PipeWireSinkName,{y}")
    rec = Recording(audio.env, sink=y)
    open(arm, "w").close()
    fppd.command("Play Media", "B.wav", "1", "0", "1")
    time.sleep(6)
    samples = rec.stop()
    loud = sum(1 for _, r in rms_windows(samples) if r > 0.1) * 0.05
    assert loud >= 3.0, f"sink Y heard {loud:.2f} s of the 4 s tone"


def test_a_prewarm_while_fppd_shuts_down_does_not_abort_it(fppd, audio):
    """fppd stopped (SIGTERM) with a native plugin prewarming the media
    output from a thread of its own every 20 ms (prewarmplugin.cpp), and the
    output stream's worker slow to finish (pwstream_slowworker.c holds it
    3 s): fppd exits cleanly, without std::terminate(). fppd shuts its
    plugins down after the media output, so the plugin is still asking for
    the stream while the worker is being joined.

    Regression: 9845cbc29. ShutdownAll() marked the worker stopped,
    released the lock and only then joined it. A ForSlot() in between -- a
    prewarm, the keep-open settings listener -- saw the worker stopped and
    assigned a new std::thread over the one still being joined, which is
    std::terminate()."""
    import signal
    import plugin_build
    arm = os.path.join(fppd.media, "tmp", "arm")
    plugin_build.build_and_install(fppd, "prewarmplugin.cpp", "fpp-prewarm")
    fppd.start(preload=[shims.build("pwstream_slowworker.c", libs=("-ldl", "-lpthread"))],
               extra_env={"SLOWWORKER_ARM": arm, "SLOWWORKER_MS": "3000"})
    fppd.wait_for(lambda: "prewarm plugin fpp-prewarm loaded" in fppd.log(), timeout=15,
                  interval=0.25, what="the plugin to load")
    time.sleep(1)
    open(arm, "w").close()
    fppd.exit_expected = True
    fppd.proc.send_signal(signal.SIGTERM)
    rc = fppd.proc.wait(timeout=60)
    log = fppd.log()
    assert "terminate called" not in log and "Crash handler called" not in log, \
        "\n".join(l for l in log.splitlines() if "terminate" in l or "Crash" in l)
    assert rc == 0, f"fppd exited {rc}"
