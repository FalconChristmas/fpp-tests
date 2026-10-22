"""An inserted playlist's link to the playlist it interrupted, used from HTTP
threads while the main loop releases levels.

A race: red only under TSan (run.sh --flavor tsan); elsewhere coverage.
Entries append digits to a trace (see test_playlist_entries.py).
"""

import time

from test_playlist_b_races import hammer
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, status, step, trace


def test_starts_and_stops_while_playlists_are_inserted(fppd):
    """Start Playlist from two HTTP threads and Stop Now from a third while a
    fourth keeps inserting a one-entry playlist, and status is polled: fppd
    keeps answering, and once they stop a playlist starts and plays on to
    its second entry.

    Regression: 4a22890ad. A Start Playlist reaching an inserted playlist
    stops it, and its SetIdle hands the player back to the parent, resumes
    it and reads its status. The parent was a raw pointer: a second Start
    Playlist that already saw the parent as current condemned it, and the
    main loop freed it while the first was still reading it -- a
    use-after-free (TSan: m_status read in SetIdle against the delete in
    DrainRetiredPlaylists).
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1), step(2), pause(60)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7), pause(0.2)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")

    def starts():
        fppd.command("Start Playlist", "P", "false", "false", timeout=10)
        time.sleep(0.1)

    def starts_too():
        fppd.command("Start Playlist", "P", "false", "false", timeout=10)
        time.sleep(0.09)

    def stops():
        fppd.command("Stop Now", timeout=10)
        time.sleep(0.23)

    def inserts():
        fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false", timeout=10)
        time.sleep(0.07)

    hammer(fppd, 20, starts, starts_too, stops, inserts,
           lambda: fppd.get("/fppd/status", timeout=10))
    # Stop Now stops one level: one landing on an inserted Q resumes the
    # playlist under it, and inserts can stack up to 10 deep.
    for _ in range(12):
        fppd.command("Stop Now")
        if status_name(fppd) == "idle":
            break
    wait_idle(fppd)
    start(fppd, "P")
    wait_trace(fppd, "12")
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_a_stop_drops_an_insert_still_waiting_to_start(fppd):
    """A playlist inserted to play after the current item, then Stop Now
    before that item ends: the insert goes with the stopped playlist, and the
    next playlist started plays without it.

    Regression: 416e319ec. The pending insert outlived the stop, and the
    next playlist started ran it after its first entry.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1), step(2), pause(60)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "12")
    fppd.command("Insert Playlist After Current", "Q", "-1", "-1", "false")
    fppd.command("Stop Now")
    wait_idle(fppd)
    start(fppd, "P")
    fppd.wait_for(lambda: (trace(fppd) or "").endswith("2"), what="P's second entry")
    assert trace(fppd) == "12", "Q ran inside the new P: " + trace(fppd)
    assert status(fppd)["current_playlist"]["playlist"] == "P"
    fppd.command("Stop Now")
    wait_idle(fppd)
