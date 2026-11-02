"""The breadcrumbs in the status JSON: while a playlist inserted into another
runs, the names of the playlists above it, outermost first, and none once
it has handed back (or when the playlist was started on its own).
"""

import time

from test_playlist_commands import start, wait_idle
from test_playlist_entries import pause, playlist, status, step


def crumbs(fppd):
    s = status(fppd)
    return s.get("current_playlist", {}).get("playlist"), s.get("breadcrumbs", [])


def test_an_inserted_playlist_reports_the_playlists_above_it(fppd):
    """P runs a long pause; Q is inserted into it, and R into Q. While R
    plays the status names P and Q above it, in that order; the status of P
    on its own has none.

    Regression: 404df02a6. The status gave only the current playlist's name,
    so a nested playlist could not be told from a top-level one (the status
    heading's "Player Status (P -> Q -> R)" came from this list).
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(120)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[
        {"type": "command", "enabled": 1, "playOnce": 0, "command": "Insert Playlist Immediate",
         "args": ["R", "0", "0", "false"]}, pause(120)]))
    fppd.write("playlists/R.json", playlist("R", main=[pause(120)]))
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: crumbs(fppd) == ("P", []), timeout=10, what="P to play on its own")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    fppd.wait_for(lambda: crumbs(fppd) == ("R", ["P", "Q"]), timeout=10,
                  what="R to play with P and Q above it")
    for _ in range(3):  # each stop ends the innermost playlist
        fppd.command("Stop Now")
        time.sleep(0.5)
    wait_idle(fppd)


def test_the_breadcrumbs_go_when_the_inserted_playlist_hands_back(fppd):
    """Q, inserted into P, plays a short pause and ends: the status goes
    from ("Q", ["P"]) back to ("P", []).

    Regression: 404df02a6 -- the list is built from the playlist's parents,
    so once the parent is current again there is nothing above it.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(120)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[pause(3)]))
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: crumbs(fppd) == ("P", []), timeout=10, what="P to play on its own")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    fppd.wait_for(lambda: crumbs(fppd) == ("Q", ["P"]), timeout=10, what="Q to play inside P")
    fppd.wait_for(lambda: crumbs(fppd) == ("P", []), timeout=15, what="P to be current again")
    fppd.command("Stop Now")
    wait_idle(fppd)
