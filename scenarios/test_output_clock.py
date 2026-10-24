"""The channel output thread's frame clock across wall-clock steps.

An NTP correction, a GPS fix or a cape RTC that boots years in the past can
step the wall clock by any amount while a show plays. Frames have to keep
going out at the sequence's rate through either direction of step, and an
output's own timeouts have to keep their length.
"""

import os
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

    Regression: c1c9ae59e. The playlist's sequence entry timed its frames
    from a wall-clock start, so after a step it told the output thread it was
    an hour ahead or behind: a step forward stopped the frames, a step back
    held the sequence short of its end.
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


def test_a_serial_write_to_a_stalled_port_gives_up_across_a_clock_step(fppd):
    """A serial output whose port has stopped draining still gives up each
    frame's write after its 500 ms, when the wall clock steps back an hour
    mid-write: fppd then stops within seconds, its output worker with it.

    The port is a pty nothing reads, so once its buffer is full every write
    of a 4000-channel GenericSerial frame waits out its deadline.

    Regression: 54ce7de27. SerialWriteAll() set its deadline on the wall
    clock, so the write in progress when the clock stepped back waited an
    hour for a port that never drained, and stopping fppd (or reloading the
    outputs) waited on that worker.
    """
    master, slave = os.openpty()
    try:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 4000,
            "description": "stalled", "device": os.ttyname(slave)[len("/dev/"):],
            "speed": 115200, "header": "", "footer": ""}]})
        fppd.start(fake_time="2026-12-24 18:00:00")
        fppd.request("PUT", "/overlays/range/1-4000", {"Value": 0x40})
        time.sleep(3)  # the pty's buffer fills; each write now runs to its deadline
        fppd.set_clock("2026-12-24 17:00:03")
        time.sleep(2)
        started = time.monotonic()
        rc = fppd.stop(timeout=15)
        took = time.monotonic() - started
        fppd.exit_expected = True
        assert rc == 0, f"fppd exited with {rc} on SIGTERM\n{fppd.tail()}"
        reports = fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
        assert took < 5, f"fppd took {took:.1f} s to stop"
    finally:
        os.close(master)
        os.close(slave)
