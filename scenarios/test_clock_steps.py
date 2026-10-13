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
        effect(fppd, "M", "Bars", Direction="Down")
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
    time.sleep(5)
    samples = rec.stop()
    first, last = sounding(samples)
    assert first is not None, "nothing was heard"
    assert last - first >= 4.6, f"heard {last - first:.2f} s of a 5 s file across the clock step"
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle", timeout=5,
                  what=f"the player to go idle after the media, the clock having stepped {step}")
