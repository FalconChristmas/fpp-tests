"""Start Playlist At Item for the playlist the schedule wants: the scheduler starts
it, so its window still ends it."""

import time

from fseq import solid_frames
from show import CHANNELS, install, playlist, sequence_entry, status
from test_scheduler import schedule_entry, wall_of, window


def test_starting_the_scheduled_playlist_by_hand_still_ends_with_its_window(fppd):
    """The scheduled playlist is stopped by hand inside its window; Start
    Playlist At Item for it (with the schedule's repeat) hands it back to the
    scheduler, so it plays again and stops when the window closes.

    Regression: 606ace169. The command started the playlist directly, at
    manual priority, so it was no longer the scheduler's: it ignored the
    window's end and played on until stopped (the scheduler also kept
    treating the stop as a user's and would not restart it)."""
    seq_seconds = 2
    install(fppd, solid_frames(seq_seconds * 20, CHANNELS, 55))
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")], repeat=1))
    start, end = window(-60, 14)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end, stop_type=1)])
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                  interval=0.5, what="the scheduled playlist to start")
    fppd.command("Stop Now")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  interval=0.2, what="the stop by hand")
    fppd.command("Start Playlist At Item", "Show", "1", "true", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  interval=0.2, what="the playlist to start again")
    due = wall_of(end)
    assert due - time.monotonic() > 2, "setup took too long: the window is nearly over"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                  interval=0.2, what="the window's end to stop the playlist started by hand")
    stopped = time.monotonic() - due
    assert -0.5 <= stopped <= 3.0, f"stopped {stopped:+.2f} s from the window's end"
