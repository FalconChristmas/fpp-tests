"""A playlist caught between two items: the moments a playlist's position
or section are left pointing past the end of a section for the main loop's
next pass to resolve, and the requests from other threads that land there.

pl_slowloop.so slows the main loop to one pass every 400 ms while a test
wants it, so a state one pass leaves behind lasts long enough for requests
polled from other threads to be sure to land in it.

Entries append digits to a trace (see test_playlist_entries.py).
"""

import os
import threading
import time

import shims
from test_playlist_commands import start, wait_trace
from test_playlist_entries import pause, playlist, status, step


def slow_loop(fppd):
    """fppd started with pl_slowloop.so; returns the file that turns it on."""
    slow = os.path.join(fppd.media, "tmp", "slowloop")
    fppd.start(preload=[shims.build("pl_slowloop.c")],
               extra_env={"PL_SLOWLOOP_FILE": slow, "PL_SLOWLOOP_MS": "400"})
    return slow


def poll_until(fppd, done, seconds, *paths):
    """Poll each path from its own thread until done() or `seconds` pass;
    a request that fails (fppd gone or wedged) fails the test."""
    stop = threading.Event()
    errors = []

    def run(path):
        try:
            while not stop.is_set():
                fppd.get(path, timeout=10)
        except Exception as e:  # noqa: BLE001 -- reported below
            errors.append((path, e))
            stop.set()

    threads = [threading.Thread(target=run, args=(p,), daemon=True) for p in paths]
    for t in threads:
        t.start()
    deadline = time.monotonic() + seconds
    try:
        while not stop.is_set() and time.monotonic() < deadline and not done():
            time.sleep(0.05)
    finally:
        stop.set()
        for t in threads:
            t.join(20)
    assert not errors, f"{errors[0][0]}: {errors[0][1]}\n{fppd.tail()}"


def empty_the_lead_out(fppd, name):
    """Start a playlist with a lead-out, then save it without one while its
    main section plays (see the test below for what that leaves behind)."""
    path = os.path.join(fppd.media, "playlists", f"{name}.json")
    fppd.write(f"playlists/{name}.json",
               playlist(name, main=[step(1), pause(2)], lead_out=[step(9)],
                        globalPauseBetweenSequencesMS=1000))
    slow = slow_loop(fppd)
    start(fppd, name)
    wait_trace(fppd, "1")
    fppd.write(f"playlists/{name}.json",
               playlist(name, main=[step(1), pause(2)], globalPauseBetweenSequencesMS=1000))
    later = time.time() + 30
    os.utime(path, (later, later))
    return slow


def test_status_while_a_reload_empties_the_lead_out(fppd):
    """A playlist file saved without its lead-out while the main section
    plays: at the end of the main section fppd reloads the file and switches
    to the now-empty lead-out, leaving the playlist "playing" at position 0
    of an empty section until the main loop's next pass stops it. Status
    polled from three threads across that pass answers every time, and the
    playlist goes idle.

    Regression: e5c2e4120. GetCurrentStatus() indexed the current section
    with at() guarded only by a null check, so a status request landing
    while the position sat at the section's size threw std::out_of_range
    out of the HTTP handler and aborted fppd. The global pause between
    sequences keeps the switch from starting the (now gone) lead-out entry,
    so the position is left at the end of the section. Since f684ec6f5 the
    switch finds the lead-out empty and stops at once, so on later trees
    this no longer reaches that state (test_playlist_b_teardown.py has the
    red check for f684ec6f5)."""
    slow = empty_the_lead_out(fppd, "P")
    open(slow, "w").close()
    try:
        poll_until(fppd, lambda: status(fppd).get("status_name") == "idle", 15,
                   "/fppd/status", "/fppd/status", "/fppd/status")
    finally:
        os.unlink(slow)
    assert status(fppd).get("status_name") == "idle", "the playlist did not stop"

