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
