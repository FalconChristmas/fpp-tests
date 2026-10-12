"""Playlist control: starting, stepping and stopping playlists."""

import time

import pytest


def command_entry(command, *args):
    return {"type": "command", "enabled": 1, "playOnce": 0,
            "command": command, "args": [str(a) for a in args]}


def playlist(name, main, repeat=1):
    return {"name": name, "repeat": repeat, "loopCount": 0,
            "leadIn": [], "mainPlaylist": main, "leadOut": []}


@pytest.mark.parametrize("command", ["Restart Playlist Item", "Next Playlist Item", "Prev Playlist Item"])
def test_entry_that_steps_its_own_playlist(fppd, command):
    """A command entry that restarts, advances or rewinds the playlist it is
    in, as the only entry of a repeating playlist, lands back on itself.

    Regression: 0da72d982, with the general command-depth guard from
    19f8cec08 as a backstop (either one alone keeps this green; red needs a
    tree from before both). The entry ran its command inline from its own
    StartPlaying(), which started the same entry again, recursing until the
    main thread's stack overflowed -- a crash loop on a scheduled playlist.
    """
    fppd.write("playlists/Loop.json", playlist("Loop", [command_entry(command)]))
    fppd.start()

    fppd.command("Start Playlist", "Loop", "true", "false")
    # Give a runaway loop time to blow the stack, or a bounded one time to be
    # stopped, while checking that fppd keeps answering throughout.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        fppd.get("/fppd/status", timeout=5)
        time.sleep(0.2)
