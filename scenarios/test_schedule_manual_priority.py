"""A playlist started with the Start Playlist command while a schedule
window opens: the command starts it at manual priority, above every
schedule entry, so the entry coming due leaves it playing; started
"Protected from Schedule Override", the scheduler also reports the entry it
held back, which the status page shows.

Builds on test_manual_start_in_schedule's helpers (status, a second show).
"""

import time

from show import status
from test_manual_start_in_schedule import _entry_comes_due_over, current


def start_other(fppd, protected):
    # name, repeat, if not running, schedule protected
    fppd.command("Start Playlist", "Other", "true", "false", "true" if protected else "false")


def test_entry_coming_due_leaves_a_command_started_playlist_playing(fppd):
    """A playlist started with Start Playlist plays on when a schedule
    entry's window opens under it.

    Regression: 7dc796222 (its scheduler half). The scheduler stopped any
    playlist started by hand as soon as an entry came due, whatever the
    priorities; it now stops it only for an entry of higher priority, and a
    command start is manual priority, above every entry."""
    seen = _entry_comes_due_over(fppd, lambda: start_other(fppd, False))
    assert set(seen) == {("playing", "Other")}, \
        f"the entry coming due took over a command-started playlist: {sorted(set(seen))}"


def test_protected_start_reports_the_entry_it_held_back(fppd):
    """Started "Protected from Schedule Override", the playlist plays on
    when an entry comes due, and status names the entry that was held back
    (fppd status' scheduler.blockedSchedule, which the web UI's status bar
    shows).

    Regression: 48b8cc08d. Before it the command had no protection argument
    and the scheduler reported nothing it held back."""
    seen = _entry_comes_due_over(fppd, lambda: start_other(fppd, True))
    assert set(seen) == {("playing", "Other")}, sorted(set(seen))
    blocked = fppd.wait_for(lambda: (status(fppd).get("scheduler") or {}).get("blockedSchedule"),
                            timeout=5, what="the held-back entry in status")
    assert blocked.get("playlistName") == "Show", blocked
    assert abs(int(blocked.get("blockedTime", 0)) - time.time()) < 30, blocked


def test_start_at_item_of_the_scheduled_playlist_over_a_manual_one(fppd):
    """The schedule's playlist plays, a playlist is started by hand over
    it, and then Start Playlist At Item asks for the scheduled playlist at
    its third item (with the schedule's repeat): it plays from that item.

    Regression: 900c01b7f. With a different playlist playing, a start of
    the playlist the schedule wants was handed to the scheduler instead of
    being started -- and the scheduler left the manual playlist playing, so
    the command did nothing."""
    from test_playlist_entries import pause, playlist, step, trace
    from test_scheduler import schedule_entry, window
    fppd.write("playlists/S.json", playlist("S", main=[step(1), step(2), step(3), pause(60)]))
    fppd.write("playlists/M.json", playlist("M", main=[step(7), pause(60)]))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("S", start, end)])
    fppd.start()
    fppd.wait_for(lambda: current(fppd) == ("playing", "S") and trace(fppd) == "123",
                  timeout=30, interval=0.2, what="the scheduled playlist to play")
    fppd.command("Start Playlist", "M", "false", "false")
    fppd.wait_for(lambda: current(fppd) == ("playing", "M") and trace(fppd) == "7",
                  interval=0.1, what="the playlist started by hand")
    time.sleep(1)
    # Item 4 is step 3: item 1 is the lead-in's reset, which this skips.
    fppd.command("Start Playlist At Item", "S", "4", "true", "false")
    fppd.wait_for(lambda: trace(fppd) == "73", timeout=5, interval=0.1,
                  what=f"S to play from its third step (now {current(fppd)}, trace {trace(fppd)!r})")
    assert current(fppd) == ("playing", "S"), current(fppd)
