"""Playlists read and changed from several threads at once: status polled
while inserted playlists come and go, starts and stops from HTTP threads
while the main loop releases what they leave behind, commands that step the
playlist landing while it moves between entries, and an image entry's prep
thread.

These are races. Under ASan a lost one is a use-after-free or an uncaught
exception that kills fppd; the unsynchronized reads behind them show only
under TSan (run.sh --flavor tsan). Only the image test is a red check (under
TSan); the others are coverage, as each docstring says. The red checks
for 03d956965 and 41cc31f30 read the player from a native plugin's thread
(test_playlist_plugin_reader.py).

Entries append digits to a trace (see test_playlist_entries.py).
"""

import os
import threading
import time

from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, status, step, trace


def hammer(fppd, seconds, *loops):
    """Run each loop function in its own thread, over and over, for
    `seconds`; a loop that raises (fppd wedged or gone) fails the test."""
    stop = threading.Event()
    errors = []

    def run(fn):
        try:
            while not stop.is_set():
                fn()
        except Exception as e:  # noqa: BLE001 -- reported below
            errors.append(e)
            stop.set()

    threads = [threading.Thread(target=run, args=(fn,), daemon=True) for fn in loops]
    for t in threads:
        t.start()
    try:
        stop.wait(seconds)
    finally:
        stop.set()
        for t in threads:
            t.join(20)
    assert not errors, errors[0]


def pollers(fppd):
    return (lambda: fppd.get("/fppd/status", timeout=10),
            lambda: fppd.get("/player/current", timeout=10),
            lambda: fppd.get("/player/status", timeout=10))


def test_status_polled_while_inserted_playlists_finish(fppd):
    """Status, the player's current playlist and its full status polled from
    three threads while a one-entry playlist is inserted into the running
    one over and over, each insert finishing at once and handing back: fppd
    keeps answering, and the first playlist plays on.

    Coverage for 03d956965 and c8099ec3a, not a red check: it passes on
    both parents, under ASan and TSan (40 s of it with twice the threads
    too). test_playlist_plugin_reader.py is the red check for 03d956965. The current playlist was a raw global that the main loop deleted
    while HTTP threads still used it -- a status poll racing an inserted
    playlist's end was a use-after-free (03d956965, which made the player
    own playlists through shared_ptr). A retired inserted playlist still
    pointed at its parent, which a later tick released while a thread
    holding the child could still walk to it for the status breadcrumbs
    (c8099ec3a).
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(120)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    time.sleep(0.5)

    def insert():
        fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false", timeout=10)
        time.sleep(0.05)
    hammer(fppd, 10, insert, *pollers(fppd))
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "P",
                  timeout=10, what="P to be current once the inserts stop")
    assert status_name(fppd) == "playing"
    assert trace(fppd).startswith("17"), trace(fppd)
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_starts_and_stops_from_http_threads(fppd):
    """Start Playlist and Stop Now sent from two HTTP threads at once, in
    tight loops, while status is polled: fppd keeps answering, and once
    they stop a playlist starts and stops cleanly.

    Coverage for 41cc31f30, not a red check: under TSan its parent reports
    only races elsewhere (the channel output thread, ping), the same as
    the fix does, none in the playlist code. The lists of condemned
    playlists and parked entries were filled from command threads (a load
    parks the entries it replaces, a stop condemns instances) while the
    main loop drained them with no lock, and the playlist's status flag
    was read across threads unsynchronized. test_playlist_plugin_reader.py
    is the red check for the status flag; the lists are still coverage.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(1), step(2), pause(60)]))
    fppd.start()

    def starts():
        fppd.command("Start Playlist", "P", "false", "false", timeout=10)
        time.sleep(0.1)

    def stops():
        fppd.command("Stop Now", timeout=10)
        time.sleep(0.13)
    hammer(fppd, 10, starts, stops, pollers(fppd)[0])
    fppd.command("Stop Now")
    wait_idle(fppd)
    start(fppd, "P")
    wait_trace(fppd, "12", timeout=10)
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_stepping_commands_while_the_playlist_moves_between_entries(fppd):
    """Prev, Restart and Next Playlist Item and status polls fired from
    four threads at a repeating playlist of short pauses, so they keep
    landing as it moves from one entry to the next and from the end of a
    pass to the start of the next; and the same commands, and a pause and
    resume, before any playlist has loaded. fppd keeps answering, and the
    playlist can be paused and resumed afterwards.

    Coverage for e5c2e4120 and 8f47496ac, not a red check: it passes on
    both parents (40 s of it with twice the threads too). Between entries
    the playlist's position sits at the end of its section; status
    (e5c2e4120) and Prev, Restart, a start at an index and the position
    lookups (8f47496ac) indexed the section there unchecked, and the
    std::out_of_range thrown on an API thread aborted fppd. Those readers
    take the playlist lock, which Process() holds across the whole
    advance, so this doesn't reach the window from outside.
    """
    fppd.write("playlists/P.json", playlist("P", main=[pause(0.2), pause(0.2), pause(0.2)]))
    fppd.start()
    for cmd in ("Prev Playlist Item", "Restart Playlist Item", "Next Playlist Item",
                "Pause Playlist", "Resume Playlist"):
        fppd.command(cmd, timeout=10)
    assert status_name(fppd) == "idle"

    start(fppd, "P", repeat=True)
    fppd.wait_for(lambda: status_name(fppd) == "playing", what="P to play")
    cmds = {c: (lambda c=c: fppd.command(c, timeout=10))
            for c in ("Prev Playlist Item", "Restart Playlist Item", "Next Playlist Item")}
    hammer(fppd, 10, *cmds.values(), pollers(fppd)[0])
    fppd.command("Pause Playlist")
    fppd.wait_for(lambda: status_name(fppd) in ("paused", "playing"), what="a status")
    fppd.command("Resume Playlist")
    fppd.wait_for(lambda: status_name(fppd) == "playing", what="P to play on")
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_image_entries_and_their_prep_thread(fppd):
    """A repeating playlist of image entries, each image prepared on the
    entry's own thread while the playlist thread waits for it and draws it:
    the images keep being drawn, and fppd survives.

    Regression: 02a89c299. The entry's prepared/drawn/run flags were plain
    volatile bools shared by the two threads, and "prepared" was set after
    the buffer lock was let go, so the playlist could see the flag before
    the buffer it guards. A race: red only under TSan.
    """
    from ddp import DdpReceiver
    from test_overlays import CHANNELS, HEIGHT, WIDTH, matrix, setup
    from test_playlist_images import image_entry, ppm
    setup(fppd, [matrix()])
    for name, rgb in (("A", (0, 0, 60)), ("B", (0, 60, 0))):
        ppm(os.path.join(fppd.media, "images", f"{name}.ppm"), WIDTH, HEIGHT, rgb)
    fppd.write("playlists/Img.json", {"name": "Img", "repeat": 1, "loopCount": 0, "leadIn": [],
                                      "mainPlaylist": [image_entry("A.ppm"), pause(0.3),
                                                       image_entry("B.ppm"), pause(0.3)],
                                      "leadOut": []})
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Img", "true", "false")
        time.sleep(6)
        frames = rx.snapshot()
    seen = {bytes(d[:3]) for t, d in frames}
    assert bytes((0, 0, 60)) in seen and bytes((0, 60, 0)) in seen, seen
    fppd.command("Stop Now")
    wait_idle(fppd)
