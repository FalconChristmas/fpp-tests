"""Stopping a playlist started by hand inside a schedule window hands the
player back to the scheduler."""

import os
import time

from fseq import solid_frames, write_fseq
from show import CHANNELS, install, playlist, sequence_entry, status
from test_scheduler import schedule_entry, window


def current(fppd):
    s = status(fppd)
    return s.get("status_name"), (s.get("current_playlist") or {}).get("playlist")


def test_stop_now_of_a_manual_playlist_returns_to_the_schedule(fppd):
    """Start another playlist over a scheduled one, Stop Now it, and the
    scheduled playlist plays again. Five times over, because the bug lost
    the stop in a window of a few milliseconds.

    Regression: the main loop treated "stopping now", which a Stop Now holds
    while the entry stops, as not playing, so a pass that read it never saw
    the change to idle: the stopped playlist was not cleaned up and the
    scheduler was not asked, and the player sat idle inside the window.
    Fixed by bdc71586c.
    """
    install(fppd, solid_frames(40, CHANNELS, 50))
    write_fseq(os.path.join(fppd.media, "sequences", "Other.fseq"), solid_frames(40, CHANNELS, 90),
               step_ms=50)
    fppd.write("playlists/Other.json", playlist("Other", [sequence_entry("Other.fseq")], repeat=1))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
    fppd.start()
    fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=30, interval=0.5,
                  what="the scheduled playlist to start")
    for i in range(5):
        fppd.command("Start Playlist", "Other", "true", "false")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Other"), timeout=10, interval=0.2,
                      what=f"the manual playlist to start (round {i + 1})")
        time.sleep(1.5)
        fppd.command("Stop Now")
        fppd.wait_for(lambda: current(fppd) == ("playing", "Show"), timeout=10, interval=0.2,
                      what=f"the scheduled playlist to play again after Stop Now (round {i + 1})")
