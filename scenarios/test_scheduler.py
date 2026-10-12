"""The scheduler: windows that open and close, checked on the wire.

Times are local (the container's TZ, UTC unless set). A scenario that needs a
window around "now" skips when midnight is too close for its window to fit.
"""

import datetime
import time

import pytest

from ddp import DdpReceiver
from fseq import solid_frames
from show import CHANNELS, install, playlist, sequence_entry, status

STOP_GRACEFUL, STOP_HARD, STOP_GRACEFUL_LOOP = 0, 1, 2


def schedule_entry(name, start, end, stop_type=STOP_GRACEFUL, repeat=1, day=7):
    """One entry for config/schedule.json, every day, today only."""
    today = start.strftime("%Y-%m-%d")
    return {"enabled": 1, "day": day, "playlist": name,
            "startTime": start.strftime("%H:%M:%S"), "endTime": end.strftime("%H:%M:%S"),
            "startDate": today, "endDate": today, "repeat": repeat, "stopType": stop_type}


def window(start_in, end_in):
    """(start, end) datetimes relative to now; skip if they'd cross midnight."""
    now = datetime.datetime.now().replace(microsecond=0)
    start, end = now + datetime.timedelta(seconds=start_in), now + datetime.timedelta(seconds=end_in)
    if start.date() != now.date() or end.date() != now.date():
        pytest.skip("too close to midnight for a same-day window")
    return start, end


def reload_schedule(fppd):
    fppd.post("/fppd/schedule", {"command": "reload"})


def wall_of(dt):
    """monotonic() time of a local datetime."""
    return time.monotonic() + (dt.timestamp() - time.time())


def test_booting_inside_a_window_starts_its_playlist(fppd):
    """fppd started in the middle of a schedule window plays that window's
    playlist without being asked."""
    frames = solid_frames(100, CHANNELS, 91)
    start, end = window(-60, 600)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                      interval=0.5, what="the scheduled playlist to start")
        s = status(fppd)
        assert s["current_playlist"]["playlist"] == "Show", s
        assert rx.wait_frames(10), "scheduled playback sent nothing"
        assert rx.last()[:CHANNELS] == frames[0], "the wire is not showing the scheduled sequence"


def test_window_opening_starts_on_time(fppd):
    """A window that opens while fppd is idle starts its playlist at the
    window's start second: the first frame is on the wire within a second
    or two of it, and not before."""
    frames = solid_frames(100, CHANNELS, 77)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.start()
        start, end = window(8, 600)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
        reload_schedule(fppd)
        due = wall_of(start)
        assert rx.wait_frames(5, timeout=30), "the window opened but nothing played"
        first = next(t for t, d in rx.snapshot() if d[:CHANNELS] == frames[0])
        assert -0.2 <= first - due <= 2.0, \
            f"first frame {first - due:+.2f} s from the window's start"


@pytest.mark.parametrize("stop_type", [STOP_HARD, STOP_GRACEFUL])
def test_window_end_stops_a_looping_playlist(fppd, stop_type):
    """A looping playlist stops when its window closes: at once for a hard
    stop, at the end of the sequence playing then for a graceful one."""
    seq_seconds = 4
    frames = solid_frames(seq_seconds * 20, CHANNELS, 55)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")], repeat=1))
        start, end = window(-60, 9)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end, stop_type=stop_type)])
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                      interval=0.5, what="the scheduled playlist to start")
        due = wall_of(end)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                      interval=0.2, what="the window's end to stop the playlist")
        stopped = time.monotonic() - due
        if stop_type == STOP_HARD:
            assert -0.5 <= stopped <= 2.0, f"hard stop {stopped:+.2f} s from the window's end"
        else:
            assert -0.5 <= stopped <= seq_seconds + 2.0, \
                f"graceful stop {stopped:+.2f} s from the window's end (sequence is {seq_seconds} s)"
        time.sleep(0.5)
        assert not any(rx.last()), "the output was left lit after the window closed"
