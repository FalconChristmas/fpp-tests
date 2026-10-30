"""Scheduler reporting and reach that older fixes put right, read back from
GET /fppd/schedule and /fppd/status with fppd's wall clock faked
(test_schedule_calendar.py has the helpers)."""

import datetime

from test_schedule_calendar import EVERY_DAY, YEAR, ZONE, at, entry, local
from show import status


def write_show(fppd, schedule):
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.write("config/schedule.json", schedule)


def test_the_next_playlist_has_its_scheduled_start_time(fppd):
    """The scheduler's next-playlist block in the status carries the
    upcoming item's start time, as the epoch second it starts at.

    Regression: e592a5630. scheduledStartTime was always 0, so a client
    could show the name and the text but not sort or count down to it."""
    day = datetime.date(YEAR, 6, 2)
    write_show(fppd, [entry(EVERY_DAY, "20:00:00", "21:00:00")])
    fppd.start(fake_time=at(day, "12:00:00"), tz=ZONE)
    nxt = status(fppd)["scheduler"]["nextPlaylist"]
    assert nxt["playlistName"] == "Show", nxt
    assert nxt["scheduledStartTime"] == local(day, 20, 0), nxt


def test_a_playlist_scheduled_on_a_remote_is_warned_about(fppd):
    """A player running in Remote mode with an enabled playlist in its
    schedule raises the warning "Playlist '<name>' was scheduled but system
    is running in Remote mode."; in Player mode it does not.

    Regression: af8f6bf3d. Remote mode silently ignored the schedule, so a
    playlist put on the wrong box simply never ran."""
    day = datetime.date(YEAR, 6, 2)
    write_show(fppd, [entry(EVERY_DAY, "20:00:00", "21:00:00")])
    fppd.settings(fppMode="remote")
    fppd.start(fake_time=at(day, "12:00:00"), tz=ZONE)
    want = "Playlist 'Show' was scheduled but system is running in Remote mode."
    fppd.wait_for(lambda: want in status(fppd).get("warnings", []), timeout=15,
                  what="the remote-mode warning")
