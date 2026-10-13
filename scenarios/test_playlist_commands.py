"""Playlist control commands: Start Playlist At Item, Insert Playlist After
Current / Immediate, Pause / Resume, Next / Prev Playlist Item, Toggle
Playlist and Set Playlist Repeat.

Entries append digits to a trace (see test_playlist_entries.py) and pause
entries give each command a window to land in, so the order things ran in
-- and roughly when -- is read back from /variables.
"""

import time

from test_playlist_entries import pause, playlist, status, step, trace


def start(fppd, name, repeat=False):
    fppd.command("Start Playlist", name, "true" if repeat else "false", "false")


def status_name(fppd):
    return status(fppd).get("status_name")


def wait_trace(fppd, want, timeout=10):
    return fppd.wait_for(lambda: trace(fppd) == want, timeout=timeout, interval=0.05,
                         what=f"the trace to be {want!r}")


def wait_idle(fppd, timeout=15):
    fppd.wait_for(lambda: status_name(fppd) == "idle", timeout=timeout, interval=0.1,
                  what="the player to go idle")


def test_start_at_item_then_repeat_plays_the_whole_playlist(fppd):
    """Start Playlist At Item with repeat plays from that item to the end,
    and the next pass plays the whole main section again.

    Regression: 4925edb07. Starting part-way in trimmed the entries before
    the start item out of the loaded playlist, so every repeat played only
    3 and 4.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2), step(3), step(4)],
                                            loop_count=2))
    fppd.start()
    # Starting at an item skips the lead-in, which is what resets the trace.
    # Items are numbered across the whole playlist as the editor numbers its
    # rows: 1 is the lead-in's reset, so step 3 is item 4.
    fppd.command("Set Variable", "trace", "Value", "0")
    fppd.command("Start Playlist At Item", "P", "4", "true", "false")
    wait_idle(fppd)
    assert trace(fppd) == "34" "1234"


def test_insert_after_current(fppd):
    """Insert Playlist After Current waits for the current entry (a pause)
    to finish, plays the inserted playlist, then carries on."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[step(7), step(8)]))
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    t0 = time.monotonic()
    fppd.command("Insert Playlist After Current", "Q", "-1", "-1", "false")
    time.sleep(1)
    assert trace(fppd) == "1", "the inserted playlist ran before the current entry finished"
    wait_idle(fppd)
    # Q's lead-in resets the trace, then 7 8; then P's last entry
    assert trace(fppd) == "782", trace(fppd)
    assert time.monotonic() - t0 >= 1.0


def test_insert_immediate_pauses_and_resumes(fppd):
    """Insert Playlist Immediate pauses the running playlist, plays the
    inserted one at once, then resumes the first where it was."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7), step(8)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    wait_trace(fppd, "178", timeout=3)
    time.sleep(0.5)
    assert status_name(fppd) == "playing", "the first playlist did not resume after the insert"
    fppd.command("Next Playlist Item")
    wait_trace(fppd, "1782")
    wait_idle(fppd)


def test_graceful_stop_during_an_immediate_insert_ends(fppd):
    """Stop Gracefully while an "Insert Playlist Immediate" playlist runs
    finishes that playlist and leaves the player idle.

    Regression: 85300b6ab. The paused parent was never resumed or stopped:
    the player stayed in "stopping gracefully" forever, the scheduler skipped
    it, and Resume ignored it.
    """
    # A graceful stop lets each playlist finish its current entry: 2 s left of
    # Q's pause, then whatever is left of P's 4 s one.
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(4), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7), pause(2), step(8)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    wait_trace(fppd, "17")
    fppd.command("Stop Gracefully")
    wait_idle(fppd, timeout=20)


def test_insert_that_inserts_itself_is_bounded(fppd):
    """A playlist whose entry inserts the same playlist immediately is cut
    off at a bounded depth, and fppd keeps answering.

    Coverage, not a red-before test for 83fba5958 (the insert depth cap):
    this passes on its parent too, where the earlier command nesting limit
    (19f8cec08) already stops the recursion. It keeps one of the two in
    place.
    """
    fppd.write("playlists/R.json", playlist("R", main=[
        step(1), {"type": "command", "enabled": 1, "playOnce": 0,
                  "command": "Insert Playlist Immediate", "args": ["R", "0", "0", "false"]}]))
    fppd.start()
    start(fppd, "R")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        fppd.get("/fppd/status", timeout=5)
        time.sleep(0.2)
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_pause_and_resume(fppd):
    """Pause Playlist holds the playlist (status "paused", nothing more
    runs); Resume Playlist carries on from there."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    time.sleep(0.5)  # into the pause entry (a pause between entries is ignored)
    fppd.command("Pause Playlist")
    fppd.wait_for(lambda: status_name(fppd) == "paused", what="status paused")
    time.sleep(3)  # longer than the pause entry
    assert trace(fppd) == "1", "the playlist went on while paused"
    fppd.command("Resume Playlist")
    wait_trace(fppd, "12", timeout=5)
    wait_idle(fppd)


def wait_in_pause(fppd, want):
    """Wait for the trace to read `want` and the playlist to have moved on
    into the pause after it. A command sent as soon as a step has run can
    land while that step is still the current entry."""
    fppd.wait_for(lambda: trace(fppd) == want
                  and status(fppd).get("current_playlist", {}).get("type") == "pause",
                  timeout=10, interval=0.05, what=f"the pause after {want!r}")


def test_next_and_prev_item(fppd):
    """Next Playlist Item cuts the current entry short; Prev Playlist Item
    goes back one entry."""
    fppd.write("playlists/P.json", playlist(
        "P", main=[step(1), pause(30), step(2), pause(30), step(3)]))
    fppd.start()
    start(fppd, "P")
    wait_in_pause(fppd, "1")
    fppd.command("Next Playlist Item")      # out of the first pause
    wait_in_pause(fppd, "12")
    fppd.command("Prev Playlist Item")      # from the second pause back to step 2
    wait_in_pause(fppd, "122")
    fppd.command("Next Playlist Item")      # out of the second pause, to step 3
    wait_trace(fppd, "1223")
    wait_idle(fppd)


def test_toggle_playlist(fppd):
    """Toggle Playlist starts the playlist when it isn't running and stops
    it when it is."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.start()
    fppd.command("Toggle Playlist", "P", "false", "Now")
    wait_trace(fppd, "1")
    assert status_name(fppd) == "playing"
    fppd.command("Toggle Playlist", "P", "false", "Now")
    wait_idle(fppd, timeout=5)
    assert trace(fppd) == "1"


def test_set_playlist_repeat_while_running(fppd):
    """Set Playlist Repeat turns repeat on for the running playlist: when
    the main section ends it plays again instead of stopping."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1)]))
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.command("Set Playlist Repeat", "true")
    wait_trace(fppd, "11", timeout=5)
    fppd.command("Set Playlist Repeat", "false")
    time.sleep(2.5)
    wait_idle(fppd, timeout=5)
    assert trace(fppd) in ("11", "111"), trace(fppd)
