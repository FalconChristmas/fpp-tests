"""Playlist behaviour that older fixes put right, one scenario each: what
Pause and Resume answer, a random pick that really is random, the shuffle of
a two-entry playlist and of one started with Start Playlist, and a
corrupt sequence in the list.

Entries append digits to a trace (see test_playlist_entries.py), so the
order things ran in is read back from /variables.
"""

import os
import time

from test_playlist_commands import start, status_name, wait_idle
from test_playlist_entries import pause, playlist, status, step, trace


def test_pause_and_resume_say_what_they_did(fppd):
    """The Pause Playlist and Resume Playlist commands answer "Playlist
    Paused" and "Playlist Restarted".

    Regression: 1b78e1a31. Both answered "Playlist Inserted", so a remote
    that relayed the answer reported the wrong thing."""
    fppd.write("playlists/P.json", playlist("P", main=[pause(30)]))
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: status_name(fppd) == "playing", what="the playlist to start")
    assert "Playlist Paused" in str(fppd.command("Pause Playlist"))
    assert "Playlist Restarted" in str(fppd.command("Resume Playlist"))
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_insert_random_item_is_not_always_the_same_item(fppd):
    """Insert Random Item From Playlist picks among all of the main section:
    twelve inserts from a section of four give more than one of them.

    Regression: a0fba43ff. The pick was never made for a single item (the
    first entry came out every time), and for a section of two or three
    entries it was skipped."""
    fppd.write("playlists/P.json", playlist("P", main=[pause(120)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(3), step(4), step(5), step(6)], "leadOut": []})
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "pause",
                  what="P's pause")
    got = ""
    for _ in range(12):  # the trace is a number: more digits than a double holds are lost
        fppd.command("Insert Random Item From Playlist", "Q", "true")
        fppd.wait_for(lambda: len(trace(fppd) or "") == len(got) + 1, timeout=5,
                      what="the inserted item to play")
        got = trace(fppd)
        time.sleep(0.1)
    assert len(set(got)) > 1, f"every insert was the same item: {got!r}"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_a_random_playlist_of_two_entries_comes_out_in_both_orders(fppd):
    """A playlist of two entries set to random plays them in either order:
    in twelve starts, both 12 and 21 come up.

    Regression: a78c721b2 (#1893). The shuffle refused to begin a pass with
    the entry the last pass ended on, which for two entries meant the
    first was always entry one: a random playlist of two never changed
    order."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), step(2)], random=1))
    fppd.start()
    orders = []
    for _ in range(12):
        start(fppd, "P")
        wait_idle(fppd, timeout=20)
        orders.append(trace(fppd))
    assert set(orders) == {"12", "21"}, orders


def test_start_playlist_shuffles_a_random_playlist(fppd):
    """Start Playlist (the command, which starts at position -1) shuffles a
    playlist set to random: seven starts of six entries do not all come out
    in the file's order or all in the same order.

    Regression: 04cc83b74 (#1585). The shuffle ran only for position 0,
    so Start Playlist played a random playlist in order."""
    fppd.write("playlists/P.json", playlist("P", main=[step(d) for d in range(1, 7)], random=1))
    fppd.start()
    orders = []
    for _ in range(7):
        start(fppd, "P")
        wait_idle(fppd, timeout=20)
        orders.append(trace(fppd))
    assert all(sorted(o) == list("123456") for o in orders), orders
    assert len(set(orders)) > 1, f"the same order seven times: {orders}"


def test_a_playlist_with_a_corrupt_sequence_does_not_take_fppd_down(fppd):
    """A playlist whose sequence file is not a sequence is added up when a
    plugin syncs the player to a position in it, without crashing fppd,
    the API keeps answering.

    Regression: 669454472. Reading the corrupt file's length used a null
    FSEQ handle."""
    import plugin_build
    from fseq import solid_frames, write_fseq
    from show import sequence_entry
    with open(os.path.join(fppd.media, "sequences", "Bad.fseq"), "wb") as f:
        f.write(b"PSEQ" + b"\x00" * 6)
    write_fseq(os.path.join(fppd.media, "sequences", "Good.fseq"), solid_frames(20, 30, 5))
    fppd.write("playlists/P.json", playlist("P", main=[sequence_entry("Bad.fseq"), sequence_entry("Good.fseq"),
                                                       pause(30)]))
    plugin_build.build_and_install(fppd, "syncplaylistplugin.cpp", "fpp-sync")
    fppd.start()
    fppd.wait_for(lambda: "fpp-sync Sync" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    assert str(fppd.command("fpp-sync Sync", "5000", "-1", "P")) == "ok"
    fppd.check_alive()
    status(fppd)
    fppd.command("Stop Now")


def test_a_sync_to_a_time_picks_the_entry_whose_timecode_is_just_before_it(fppd):
    """A plugin's SyncPlaylistToMS() with position -2 (entries that define a
    timecode only) starts the sequence of the entry whose timecode is the
    latest one before the time: 0:00:10 is picked for 15 s, 0:01:00 for 70 s,
    and an entry with a timecode of "Default" or one that is not a time is
    not a candidate.

    Regression: 4fc6118b8 and c12d20540. Entries had no timecode of their
    own, so a show built from timed sequences could only be synced by their
    lengths added up."""
    import plugin_build
    from fseq import solid_frames, write_fseq
    from show import sequence_entry
    for name in ("A", "B", "C", "D"):
        write_fseq(os.path.join(fppd.media, "sequences", name + ".fseq"), solid_frames(1200, 30, 5))  # 60 s
    main = [sequence_entry("A.fseq"), sequence_entry("B.fseq"), sequence_entry("C.fseq"), sequence_entry("D.fseq")]
    for e, tc in zip(main, ("0:00:10", "0:01:00", "Default", "later")):
        e["timecode"] = tc
    fppd.write("playlists/P.json", playlist("P", main=main))
    plugin_build.build_and_install(fppd, "syncplaylistplugin.cpp", "fpp-sync")
    fppd.start()
    fppd.wait_for(lambda: "fpp-sync Sync" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")

    def synced_to(ms):
        assert str(fppd.command("fpp-sync Sync", str(ms), "-2", "P")) == "ok"
        return fppd.wait_for(lambda: status(fppd).get("current_sequence") or None, timeout=10,
                             what=f"a sequence to start for {ms} ms")
    assert synced_to(15000) == "A.fseq"
    assert synced_to(70000) == "B.fseq"
    fppd.command("Stop Now")
