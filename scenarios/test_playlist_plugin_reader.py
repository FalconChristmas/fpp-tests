"""The Player read from a native plugin's own thread while the main loop
moves playlists along: a plugin's status or display thread asking whether
anything is playing, or what, with no lock of its own -- only the Player's
synchronization between it and the main loop. Under TSan (run.sh --flavor
tsan) an unsynchronized read shows as a report whether or not the read and
the write happen to overlap; under ASan these pass unless one does. The
reader is playerreaderplugin.cpp, built by plugin_build.py."""

import time

import plugin_build
from test_playlist_b_races import hammer
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import playlist, pause, status, step, trace


def reader(fppd, what):
    plugin_build.build_and_install(fppd, "playerreaderplugin.cpp", "fpp-reader")
    fppd.start(extra_env={"PR_READ": what})
    fppd.wait_for(lambda: "fpp-reader Reads" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the reader plugin to load")


def reads(fppd):
    return int(str(fppd.command("fpp-reader Reads")))


def test_a_plugin_thread_reads_the_status_of_playlists_that_end_on_their_own(fppd):
    """A short playlist started again and again, each run ending on its own
    in the main loop, while a plugin thread reads the player's status:
    every run plays, and the reads go on throughout.

    Regression: 41cc31f30 (the status flag). The playlist's status was a
    plain volatile field, written under the playlist lock by whichever
    thread moved the playlist (an HTTP start, the main loop at its end)
    and read by the getters other threads call without it, with nothing
    ordering the two. It is atomic now. (The commit's other half, the
    cleanup lists, is not reached here: every command thread that fills
    them is ordered against the main loop's drain by the player's own
    locks.)"""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(0.2), step(2)]))
    reader(fppd, "status")
    for _ in range(8):
        start(fppd, "P")
        wait_trace(fppd, "12")
        wait_idle(fppd)
    before = reads(fppd)
    time.sleep(0.3)
    assert reads(fppd) > before, "the plugin's reader thread stopped"


def test_a_plugin_thread_reads_the_current_playlist_while_inserts_finish(fppd):
    """A one-entry playlist inserted into a running one over and over, each
    insert finishing at once and handing the player back, while a plugin
    thread reads the current playlist's name: the first playlist plays on,
    and the reads go on throughout.

    Regression: 03d956965. The current playlist was a raw global: the main
    loop repointed it at the parent when an inserted playlist finished and
    then deleted the child, while a thread that had just read the global
    could still be using the child. The player now owns playlists through
    shared_ptr and hands readers a snapshot that keeps theirs alive."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(120)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    reader(fppd, "name")
    start(fppd, "P")
    wait_trace(fppd, "1")

    def insert():
        fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false", timeout=10)
        time.sleep(0.1)
    hammer(fppd, 5, insert)
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "P",
                  timeout=10, what="P to be current once the inserts stop")
    assert status_name(fppd) == "playing"
    assert trace(fppd).startswith("17"), trace(fppd)
    before = reads(fppd)
    time.sleep(0.3)
    assert reads(fppd) > before, "the plugin's reader thread stopped"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_a_plugin_thread_reads_the_position_while_playlists_are_stopped(fppd):
    """A playlist of several entries started and stopped by hand over and over,
    while a plugin thread asks it where it is (GetCurrentPosInMS, as an
    ArtNet or SMPTE timecode plugin does every frame): every start plays,
    every stop ends it, and the reads go on throughout.

    Regression: 20e39e4a9. GetCurrentPosInMS() walked the playlist's current
    section and its entries without the playlist lock, so a Stop Now taking
    them apart under it crashed fppd while a timecode plugin was running."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    reader(fppd, "pos")

    def stop_and_start():
        start(fppd, "P")
        wait_trace(fppd, "1")
        fppd.command("Stop Now")
        wait_idle(fppd)
    hammer(fppd, 15, stop_and_start)
    before = reads(fppd)
    time.sleep(0.3)
    assert reads(fppd) > before, "the plugin's reader thread stopped"
