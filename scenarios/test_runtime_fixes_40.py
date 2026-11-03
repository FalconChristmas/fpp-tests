"""Fixes from the 4.x and 5.0 releases that are still reachable in fppd."""

import time

from test_playlist_commands import wait_idle
from test_playlist_entries import pause, playlist, status, step, trace


def test_a_random_playlist_started_at_an_item_is_not_shuffled(fppd):
    """Start Playlist At Item on a randomised playlist plays the item asked
    for first, every time (the rest follow in a fresh shuffle).

    Regression: 93578ac57. The playlist was shuffled on load even when a start
    position was given, so the item asked for was whatever the shuffle left
    at that row. Twenty starts: a plain shuffle leaves step 3 at item 4 one
    time in four."""
    fppd.write("playlists/R.json", playlist("R", main=[step(1), step(2), step(3), step(4)], random=1))
    fppd.start()
    for _ in range(20):
        fppd.command("Set Variable", "trace", "Value", "0")
        fppd.command("Start Playlist At Item", "R", "4", "false", "false")
        wait_idle(fppd)
        got = trace(fppd)
        assert got.startswith("3") and sorted(got) == ["1", "2", "3", "4"], got


def test_a_playlist_entry_note_is_kept_and_reported(fppd):
    """A note on any playlist entry stays in the playlist and is part of the
    entry's reported config.

    Regression: 3ef65f983. Only some entry types carried their Note."""
    e = pause(30)
    e["note"] = "keep me"
    fppd.write("playlists/N.json", playlist("N", main=[e]))
    fppd.start()
    fppd.command("Start Playlist", "N", "false", "false")
    cur = fppd.wait_for(lambda: (lambda c: c if c.get("type") == "pause" else None)(
        fppd.get("/player/current")["playlist"].get("currentEntry", {})), what="the pause entry")
    assert cur.get("note") == "keep me", cur
    fppd.command("Stop Now")


def test_fppd_uptime_grows(fppd):
    """The status reports seconds since fppd started, and the number
    increases.

    Feature: d910a50ab (#945)."""
    fppd.start()
    a = fppd.get("/fppd/status", timeout=5)
    time.sleep(2.2)
    b = fppd.get("/fppd/status", timeout=5)
    assert b["uptimeTotalSeconds"] >= a["uptimeTotalSeconds"] + 2, (a, b)

