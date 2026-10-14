"""fppd restarting mid-show: the scheduled playlist comes back where it was,
with all of its entries.
"""

import urllib.error

from test_playlist_entries import pause, playlist, status, step, trace
from test_scheduler import schedule_entry, window


def restarted_and_playing(fppd):
    """Status once the new fppd is answering and playing, else None.

    Variables live in fppd's memory and the resume skips the lead-in, so the
    trace is gone exactly when the new process is the one answering."""
    try:
        s = status(fppd)
        if s.get("status_name") != "playing" or trace(fppd) is not None:
            return None
        return s
    except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
        return None


def test_restart_resumes_the_whole_playlist(fppd):
    """A scheduled playlist restarted part-way through resumes at the entry
    it was on, with every entry still loaded.

    Regression: 1bd28aebb. The resume loaded the playlist with every entry
    before the resume point trimmed off, so a show whose fppd restarted
    (a model upload from xLights asks for one) came back with part of its
    playlist missing: here, one entry of seven.
    """
    start, end = window(-60, 600)
    # Lead-in reset, then main: 1, 2, 3 and a long pause to restart in.
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), pause(1), step(2), pause(1), step(3), pause(120)]))
    fppd.write("config/schedule.json", [schedule_entry("P", start, end)])
    fppd.start()
    fppd.wait_for(lambda: trace(fppd) == "123", timeout=30, interval=0.1,
                  what="the scheduled playlist to reach its last entry")
    before = status(fppd)["current_playlist"]
    assert (before["count"], before["index"]) == ("7", "7"), before

    fppd.command("Restart FPPD")
    s = fppd.wait_for(lambda: restarted_and_playing(fppd), timeout=60, interval=0.5,
                      what="fppd to come back playing")
    after = s["current_playlist"]
    assert after["playlist"] == "P", after
    assert (after["count"], after["index"]) == ("7", "7"), \
        f"resumed with {after['count']} entries at {after['index']}, was 7 at 7"
