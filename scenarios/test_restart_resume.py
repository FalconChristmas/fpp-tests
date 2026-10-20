"""fppd restarting mid-show: the scheduled playlist comes back where it was,
with all of its entries.
"""

import time
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

    Also covers 0aae67041: the "Restart FPPD" command it restarts with.
    """
    start, end = window(-60, 600)
    # Lead-in reset, then main: 1, 2, 3 and a long pause to restart in.
    fppd.write("playlists/P.json", playlist("P", main=[
        step(1), pause(1), step(2), pause(1), step(3), pause(120)]))
    fppd.write("config/schedule.json", [schedule_entry("P", start, end)])
    fppd.start()
    # The trace reads 123 while step(3) is still the current entry (6), so
    # wait for the pause after it too.
    def at_last_entry():
        if trace(fppd) != "123":
            return None
        p = status(fppd)["current_playlist"]
        return p if (p["count"], p["index"]) == ("7", "7") else None
    fppd.wait_for(at_last_entry, timeout=30, interval=0.1,
                  what="the scheduled playlist to reach its last entry")

    fppd.command("Restart FPPD")
    s = fppd.wait_for(lambda: restarted_and_playing(fppd), timeout=60, interval=0.5,
                      what="fppd to come back playing")
    after = s["current_playlist"]
    assert after["playlist"] == "P", after
    assert (after["count"], after["index"]) == ("7", "7"), \
        f"resumed with {after['count']} entries at {after['index']}, was 7 at 7"


def marker(d):
    """A command entry that sets the variable "ran" to d.  Unlike step()'s
    expression, it needs no variable to exist first, so it shows up in a
    restarted fppd, where variables start empty."""
    return {"type": "command", "enabled": 1, "playOnce": 0, "command": "Set Variable",
            "args": ["ran", "Value", str(d)]}


def test_restart_resumes_a_random_playlist_on_its_entry(fppd):
    """A scheduled random playlist restarted while in its long pause resumes
    in that pause, twice over, without running any other entry first.

    Regression: f25dfcca9. The resume position mapped the current entry's
    index in the shuffled main section through the load-order row table, so
    the show came back on whichever entry was loaded at that index -- here
    usually a command that had already run. The resume puts its entry first
    in the shuffle, so a second restart went wrong every time.
    """
    start, end = window(-60, 600)
    fppd.write("playlists/P.json", playlist("P", main=[marker(d) for d in range(1, 9)] + [pause(120)],
                                            random=1))
    fppd.write("config/schedule.json", [schedule_entry("P", start, end)])
    fppd.start()

    def in_pause():
        p = status(fppd).get("current_playlist") or {}
        return p.get("type") == "pause"

    def ran():
        return (fppd.get("/variables", timeout=5) or {}).get("ran", {}).get("value")

    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing" and in_pause(),
                  timeout=30, interval=0.1, what="the scheduled playlist to reach its pause")
    assert ran() is not None, "the markers ahead of the pause set nothing: the check below is blind"
    for n in range(2):
        # The uptime falling is how the new process is told apart.
        fppd.wait_for(lambda: status(fppd)["uptimeTotalSeconds"] >= 2, timeout=10,
                      what="fppd to have been up a while")
        before = status(fppd)["uptimeTotalSeconds"]
        fppd.command("Restart FPPD")

        def restarted_playing():
            try:
                s = status(fppd)
            except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
                return None
            return s if (s["uptimeTotalSeconds"] < before and s.get("status_name") == "playing") else None

        fppd.wait_for(restarted_playing, timeout=60, interval=0.2, what="fppd to come back playing")
        # A marker resumed on runs at once, followed by the others shuffled
        # ahead of the pause; the variables start empty in the new process.
        time.sleep(1.5)
        p = status(fppd)["current_playlist"]
        r = ran()
        assert r is None and p.get("type") == "pause", \
            f"restart {n + 1}: resumed and ran marker {r!r}, now on {p.get('type')} -- was in the pause"
