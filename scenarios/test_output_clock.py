"""The channel output thread's frame clock across wall-clock steps.

An NTP correction, a GPS fix or a cape RTC that boots years in the past can
step the wall clock by any amount while a show plays. Frames have to keep
going out at the sequence's rate through either direction of step.
"""

import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames
from show import CHANNELS, install, status


@pytest.mark.parametrize("step", ["back an hour", "forward an hour"])
def test_sequence_keeps_playing_through_a_clock_step(fppd, step):
    """A sequence keeps sending frames at its own rate, and reaches its end,
    when the wall clock steps mid-show.

    Regression: fef65433c scheduled each frame a fixed period after the
    previous one was due, carrying the due time from frame to frame on the
    wall clock. After a step back the next frame was due an hour later and
    the output thread slept that long: no frames at all. Fixed by 9924238da
    (the cadence on the monotonic clock).
    """
    frames = unique_frames(400, CHANNELS)  # 20 s at 50 ms
    lookup = {f: i for i, f in enumerate(frames)}
    target = "2026-12-24 17:00:05" if step == "back an hour" else "2026-12-24 19:00:05"
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.start(fake_time="2026-12-24 18:00:00")
        fppd.command("Start Playlist", "Show", "false", "false")
        assert rx.wait_frames(40, timeout=10), "the sequence never reached the wire"

        fppd.set_clock(target)
        stepped = time.monotonic()
        time.sleep(2)
        sent = rx.count(since=stepped + 0.5)
        assert sent >= 20, f"only {sent} frames went out in the 1.5 s after the clock stepped {step}"

        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                      interval=0.25, what="the sequence to play to its end")
        played = {lookup[f] for _, f in rx.snapshot() if f in lookup}
        assert max(played) == len(frames) - 1, "the sequence did not reach its last frame"
