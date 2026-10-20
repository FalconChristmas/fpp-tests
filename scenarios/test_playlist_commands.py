"""Playlist control commands: Start Playlist At Item, Insert Playlist After
Current / Immediate, Pause / Resume, Next / Prev Playlist Item, Toggle
Playlist and Set Playlist Repeat.

Entries append digits to a trace (see test_playlist_entries.py) and pause
entries give each command a window to land in, so the order things ran in
-- and roughly when -- is read back from /variables.
"""

import time

import pytest

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


def test_start_at_item_keeps_every_entry(fppd):
    """Start Playlist At Item starts at that item with the whole playlist
    loaded: status counts every entry and numbers the current one as the
    playlist file does.

    Regression: 1bd28aebb. The entries before the start item were trimmed
    out of the loaded playlist, so status showed 1 entry of 5 and called
    the pause item 1.
    """
    # Item 5 is the pause: the lead-in's reset is item 1.
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2), step(3), pause(30)]))
    fppd.start()
    fppd.command("Start Playlist At Item", "P", "5", "false", "false")
    fppd.wait_for(lambda: status_name(fppd) == "playing", what="the playlist to start")
    cur = status(fppd)["current_playlist"]
    assert (cur["count"], cur["index"]) == ("5", "5"), cur
    assert trace(fppd) is None, "entries before the start item ran"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_start_at_item_of_a_random_playlist(fppd):
    """Start Playlist At Item on a random playlist plays that item first,
    then every other main entry in a shuffle: in a shuffled playlist an
    item's row says nothing about which of the others have played.

    Regression: 1bd28aebb. Before it the start item was trimmed down to the
    entries after it and those shuffled, so the requested item rarely
    played first and the earlier ones never played.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(d) for d in range(1, 6)], random=1))
    fppd.start()
    # Starting at an item skips the lead-in's reset.  Five runs, so a
    # shuffle that merely happened to put 3 first can't pass alone.
    for _ in range(5):
        fppd.command("Set Variable", "trace", "Value", "0")
        fppd.command("Start Playlist At Item", "P", "4", "false", "false")
        wait_idle(fppd)
        t = trace(fppd)
        assert t and t[0] == "3" and sorted(t) == list("12345"), t


def test_start_at_item_of_the_playing_random_playlist(fppd):
    """Start Playlist At Item row 4 (step 3) on the random playlist that is
    playing, five times over: step 3 is what plays next each time.

    Regression: 93ed185e2. Starting at an item of the playlist already
    playing takes the jump fast path, which mapped the row to a position in
    load order and then started whatever sat at that index of the shuffled
    main playlist, so the requested entry played one time in N.
    """
    # rows: 1 the lead-in's reset, 2-6 steps 1-5, 7 a long pause
    fppd.write("playlists/P.json", playlist("P", main=[step(d) for d in range(1, 6)] + [pause(60)],
                                            random=1))
    fppd.start()
    got = []
    for _ in range(5):
        start(fppd, "P")
        fppd.wait_for(lambda: status_name(fppd) == "playing"
                      and status(fppd).get("current_playlist", {}).get("type") == "pause",
                      timeout=10, what="P's pause")
        fppd.command("Set Variable", "trace", "Value", "0")
        fppd.command("Start Playlist At Item", "P", "4", "false", "false")
        try:
            fppd.wait_for(lambda: trace(fppd), timeout=3, what="an entry to run")
            got.append(trace(fppd)[0])
        except TimeoutError:
            got.append("the pause")
        fppd.command("Stop Now")
        wait_idle(fppd)
    assert got == ["3"] * 5, f"first entry run after Start At Item row 4, each time: {got}"


@pytest.mark.parametrize("command", ["Insert Playlist Immediate", "Insert Playlist After Current"])
def test_insert_one_item_plays_only_that_item(fppd, command):
    """An insert whose start and end item are the same plays just that entry
    of the inserted playlist, then carries on with the first one.  This is
    how Remote Falcon plays a requested song; the start-part-way change in
    1bd28aebb must leave it alone.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7), step(8), step(9)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_in_pause(fppd, "1")
    fppd.command(command, "Q", "2", "2", "false")
    wait_idle(fppd)
    # Immediate plays item 2 inside P's pause, After Current after it; either
    # way before P's last entry.  A 7 or 9 would mean more of Q played.
    assert trace(fppd) == "182", trace(fppd)


def test_insert_after_current(fppd):
    """Insert Playlist After Current waits for the current entry (a pause)
    to finish, plays the inserted playlist, then carries on."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[step(7), step(8)]))
    fppd.start()
    start(fppd, "P")
    # Not just the trace: inserted while step 1 is still current, Q rightly
    # plays after step 1, ahead of the pause.
    wait_in_pause(fppd, "1")
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
    the main section ends it plays again instead of stopping.

    Feature: 483874dd5."""
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


def test_restart_of_the_running_playlist_keeps_it_loaded(fppd):
    """Start Playlist At Item on the playlist already playing, with a
    different repeat flag, restarts it there and it plays on; three times
    over.

    Regression: 44e46b706. The restart stops the playlist and waits 100 ms
    under its lock; the main loop saw it idle meanwhile and queued a
    cleanup behind that lock, which then wiped the restarted playlist:
    status "playing" with no playlist name and no entries, and nothing
    more played until someone pressed Stop.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2), pause(20)]))
    fppd.start()
    for _ in range(3):
        start(fppd, "P")
        wait_trace(fppd, "12")
        # Row 1 is the lead-in's reset, so row 2 is step 1. The trace isn't
        # reset this way: it carries on from "12".
        fppd.command("Start Playlist At Item", "P", "2", "true", "false")
        wait_trace(fppd, "1212", timeout=6)
        cur = status(fppd).get("current_playlist", {})
        assert cur.get("playlist") == "P", cur
        fppd.command("Stop Now")
        wait_idle(fppd)


def test_insert_after_current_into_an_inserted_playlist_with_a_lead_out(fppd):
    """Insert Playlist After Current while an inserted playlist is on its
    last main entry, with its lead-out still to play, waits for that
    playlist's lead-out before playing the new one.

    Regression: 83fba5958. Its test of whether the current playlist would
    stop after the current entry was inverted: the inserted playlist was
    taken as ending, the new insert replaced it, and its lead-out never
    played.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(5), pause(3)], "leadOut": [step(6)]})
    fppd.write("playlists/R.json", {"name": "R", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_in_pause(fppd, "1")
    fppd.command("Insert Playlist After Current", "Q", "-1", "-1", "false")
    wait_in_pause(fppd, "15")
    fppd.command("Insert Playlist After Current", "R", "-1", "-1", "false")
    wait_idle(fppd, timeout=20)
    assert trace(fppd) == "15762", trace(fppd)


def test_insert_random_item_comes_from_the_main_section(fppd):
    """Insert Random Item From Playlist plays one entry from the playlist's
    main section, never its lead-in or lead-out.

    Regression: 6eedfedee. The random single entry was loaded with the
    lead-in first, which took the one slot: it always played the lead-in.
    """
    fppd.write("playlists/P.json", playlist("P", main=[pause(60)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0,
                                    "leadIn": [step(9)], "mainPlaylist": [step(3), step(4), step(5)],
                                    "leadOut": [step(8)]})
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "pause",
                  what="P's pause")
    got = ""
    for _ in range(5):
        fppd.command("Insert Random Item From Playlist", "Q", "true")
        fppd.wait_for(lambda: len(trace(fppd) or "") == len(got) + 1, timeout=5,
                      what="the inserted item to play")
        got = trace(fppd)
        time.sleep(0.3)
    assert set(got) <= set("345"), f"inserted items {got!r}"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_stop_during_an_insert_start_stops_the_inserted_playlist(fppd):
    """Stop Now that arrives while an inserted playlist is still starting
    (its sequence slow to open) stops the inserted playlist once it is
    current, and the first one carries on: one Stop Now unwinds one level.

    Regression: 48ba58136 (repaired by 41485599f; checked red at 8aff2cf96,
    the last commit before it that builds). Commands took a snapshot of
    the current playlist, then waited for its lock, which the first
    playlist holds while it starts the inserted one; the stop then ran on
    the first playlist after the inserted one had become current: the
    output was blanked and idle published while the inserted playlist
    played on.
    """
    import os

    import shims
    from fseq import solid_frames, write_fseq
    from show import sequence_entry
    write_fseq(os.path.join(fppd.media, "sequences", "Q.fseq"), solid_frames(40, 30, 9))  # 2 s
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [sequence_entry("Q.fseq"), step(7)],
                                    "leadOut": []})
    fppd.start(preload=[shims.build("slowfileopen.c")],
               extra_env={"SLOWFILEOPEN_SUFFIX": "/Q.fseq", "SLOWFILEOPEN_MS": "2000"})
    start(fppd, "P")
    wait_in_pause(fppd, "1")
    t1 = time.monotonic()
    fppd.command("Insert Playlist After Current", "Q", "-1", "-1", "false")
    # The pause ends about 2 s after step 1; Q then loads and starts under
    # P's lock, opening Q.fseq slowly.
    time.sleep(max(0, t1 + 2.5 - time.monotonic()))
    fppd.command("Stop Now", timeout=20)
    cur = status(fppd).get("current_playlist", {}).get("playlist")
    assert cur == "P", f"after Stop Now during Q's start the current playlist is {cur!r}"
    wait_idle(fppd, timeout=20)
    time.sleep(1)
    assert "7" not in (trace(fppd) or ""), f"Q played on after Stop Now: trace {trace(fppd)!r}"
