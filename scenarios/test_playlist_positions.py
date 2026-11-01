"""The playlist positions a timecode plugin works with: every entry of a
loaded playlist has a 0-based position that runs through the lead-in, the
main section and the lead-out, and Player::FindPosForMS(),
Player::GetFilenamesForPos(), Playlist::GetCurrentPosInMS(pos, posms) and
MultiSync::SyncPlaylistToMS() take and answer in those positions. Nothing
in fpp calls them except SyncPlaylistToMS(); a plugin does, so the caller
here is playlistposplugin.cpp, built by plugin_build.py.

The playlist: position 0 is the lead-in's reset command, 1 a 1 s sequence,
2 a 2 s pause, 3 a 1.5 s sequence, and 4 a 1 s pause in the lead-out."""

import os

import plugin_build
from fseq import solid_frames, write_fseq
from show import sequence_entry
from test_playlist_commands import start
from test_playlist_entries import pause, playlist, status

NAME = "fpp-pos"


def seqs(fppd):
    write_fseq(os.path.join(fppd.media, "sequences", "A.fseq"), solid_frames(20, 30, 1))  # 1 s
    write_fseq(os.path.join(fppd.media, "sequences", "B.fseq"), solid_frames(30, 30, 2))  # 1.5 s


def setup(fppd):
    seqs(fppd)
    fppd.write("playlists/P.json", playlist(
        "P", main=[sequence_entry("A.fseq"), pause(2), sequence_entry("B.fseq")],
        lead_out=[pause(1)]))
    plugin_build.build_and_install(fppd, "playlistposplugin.cpp", NAME)
    fppd.start()
    fppd.wait_for(lambda: f"{NAME} Load" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")


def ask(fppd, what, *args):
    return str(fppd.command(f"{NAME} {what}", *args))


def test_find_position_and_filenames_use_zero_based_positions(fppd):
    """FindPosForMS() answers the position of the entry a time falls in and
    how far into it, GetFilenamesForPos() the sequence and media of the entry
    at a position, both counted from 0 through lead-in, main section and
    lead-out; a time past the end answers -1.

    Regression: 4f43eb1b3. A timecode plugin whose hour field names a
    position needs it to be the entry's own, so every entry is numbered when
    the playlist loads; the lookups had counted from 1 within what was
    playing, which a position taken from a time code does not match."""
    setup(fppd)
    assert ask(fppd, "Load", "P") == "ok"
    assert ask(fppd, "FindPos", "500") == "1 500"
    assert ask(fppd, "FindPos", "1000") == "2 0"
    assert ask(fppd, "FindPos", "3500") == "3 500"
    assert ask(fppd, "FindPos", "4500") == "4 0"
    assert ask(fppd, "FindPos", "6000") == "-1 0"
    assert ask(fppd, "Files", "0") == "|"
    assert ask(fppd, "Files", "1") == "A.fseq|"
    assert ask(fppd, "Files", "2") == "|"
    assert ask(fppd, "Files", "3") == "B.fseq|"


def test_current_position_names_the_entry_playing(fppd):
    """While the pause at position 2 plays, GetCurrentPosInMS(pos, posms)
    answers the time into the playlist, position 2, and the time into the
    pause.

    Regression: 4f43eb1b3. The overload that also hands back the playing
    entry's position and its elapsed time is what a timecode plugin sends
    out."""
    seqs(fppd)
    fppd.write("playlists/R.json", playlist("R", main=[sequence_entry("A.fseq"), pause(60)]))
    plugin_build.build_and_install(fppd, "playlistposplugin.cpp", NAME)
    fppd.start()
    fppd.wait_for(lambda: f"{NAME} Load" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    start(fppd, "R")
    fppd.wait_for(lambda: ask(fppd, "Current").split()[1] == "2", timeout=15, interval=0.1,
                  what="the pause to be current")
    ms, pos, posms = (int(x) for x in ask(fppd, "Current").split())
    assert pos == 2
    assert ms - posms == 1000
    assert 0 <= posms < 10000
    fppd.command("Stop Now")


def test_sync_playlist_to_a_time_or_a_position(fppd):
    """SyncPlaylistToMS() with a time alone finds the entry the time falls in
    and plays its sequence from there; with a position it plays that entry's
    whatever the time; a time past the end plays nothing.

    Regression: 4f43eb1b3. The position overload lets a timecode plugin
    choose the entry itself; without one the position is looked up from the
    time."""
    setup(fppd)
    cur = lambda: status(fppd).get("current_sequence", "")
    assert ask(fppd, "Sync", "3500", "none", "P") == "ok"
    fppd.wait_for(lambda: cur() == "B.fseq", timeout=10, interval=0.1,
                  what="the time to find B.fseq")
    assert ask(fppd, "Sync", "200", "1", "P") == "ok"
    fppd.wait_for(lambda: cur() == "A.fseq", timeout=10, interval=0.1,
                  what="the position to choose A.fseq")
    assert ask(fppd, "Sync", "200", "3", "P") == "ok"
    fppd.wait_for(lambda: cur() == "B.fseq", timeout=10, interval=0.1,
                  what="the position to choose B.fseq though the time is in A")
    fppd.check_alive()
