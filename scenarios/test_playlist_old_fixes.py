"""Playlist fixes from 2021-2022: inserting a playlist that is not there, the
shuffle of an inserted playlist, and a sequence whose media name has special
characters.

Entries append digits to a trace (see test_playlist_entries.py), so the
order things ran in is read back from /variables.
"""

import os
import time
import urllib.error

import pytest

from audio import write_tone_wav
from fseq import unique_frames, write_fseq
from show import CHANNELS
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, status, step, trace


@pytest.mark.parametrize("command", ["Insert Playlist Immediate", "Insert Playlist After Current"])
def test_inserting_a_playlist_that_does_not_exist_leaves_the_player_going(fppd, command):
    """Inserting a playlist that has no file, over and over, while one plays
    changes nothing: the playing playlist carries on to its end, fppd stays
    up, and a playlist started afterwards plays.

    Regression: 76a1eefc7. The failed insert's playlist object was deleted
    on the spot and then again from the cleanup list, a double free that
    took fppd down.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(3), step(2)]))
    fppd.write("playlists/Q.json", playlist("Q", main=[step(7)]))
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    for i in range(5):
        try:
            fppd.command(command, "NoSuchPlaylist", "-1", "-1", "false")
        except urllib.error.HTTPError:
            pass  # refusing it is as good as ignoring it
        time.sleep(0.2)
        fppd.check_alive()
        assert status_name(fppd) == "playing", status(fppd)
    wait_idle(fppd, timeout=20)
    assert trace(fppd) == "12", trace(fppd)
    fppd.check_alive()
    start(fppd, "Q")
    wait_idle(fppd)
    assert trace(fppd) == "7", trace(fppd)
    assert "Crash handler called" not in fppd.log(), fppd.tail()


def test_an_inserted_random_playlist_is_shuffled(fppd):
    """A playlist set to random that a command inserts plays its entries in
    a shuffled order: eight inserts of six entries all play every entry once,
    not all in the same order, and a playlist that is not random is inserted
    in its own order.

    Regression: 6d5f75ecb. A playlist inserted by another was never shuffled
    at load, so Remote Falcon-style inserts of a random playlist always came
    out in file order. (That commit also shuffled in PlaylistEntryPlaylist,
    which master no longer reaches: a "playlist" entry is inlined while the
    playlist loads.)
    """
    def inserted(name, **extra):
        p = {"name": name, "repeat": 0, "loopCount": 0, "leadIn": [], "leadOut": [],
             "mainPlaylist": [step(d) for d in range(1, 7)]}
        p.update(extra)
        return p

    fppd.write("playlists/P.json", playlist("P", main=[pause(120)]))
    fppd.write("playlists/Rand.json", inserted("Rand", random=1))
    fppd.write("playlists/Plain.json", inserted("Plain"))
    fppd.start()
    start(fppd, "P")
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "pause",
                  what="P's pause")

    def play(name):
        fppd.command("Set Variable", "trace", "Value", "0")
        fppd.command("Insert Playlist Immediate", name, "0", "0", "false")
        fppd.wait_for(lambda: len(trace(fppd) or "") == 6, timeout=10, what=f"{name} to play")
        got = trace(fppd)
        fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "pause",
                      what="P to carry on")
        return got

    assert [play("Plain") for _ in range(3)] == ["123456"] * 3
    orders = [play("Rand") for _ in range(8)]
    assert all(sorted(o) == list("123456") for o in orders), orders
    assert len(set(orders)) > 1, f"the same order eight times: {orders}"
    fppd.command("Stop Now")
    wait_idle(fppd)


def test_a_sequence_whose_media_name_has_special_characters_finds_its_media(fppd, audio):
    """Starting a .fseq whose media header names "Hi! Song #1.wav" plays the
    uploaded copy, "Hi Song 1.wav" (the name an upload is sanitized to), with
    the sequence, and raises no missing media warning.

    Regression: cfbe8479b (#1112). The media was looked for under the name
    in the header only, so a sequence made with special characters in its
    media name started without its music.
    """
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"),
               unique_frames(100, CHANNELS), media="Hi! Song #1.wav")
    write_tone_wav(os.path.join(fppd.media, "music", "Hi Song 1.wav"), 6)
    fppd.start()
    fppd.command("Start Playlist", "Show.fseq", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("current_song") == "Hi Song 1.wav", timeout=10,
                  what="the sanitized media to play")
    assert not any("lists a media file" in str(w) for w in status(fppd).get("warnings", [])), status(fppd)
    fppd.command("Stop Now")
    wait_idle(fppd)
