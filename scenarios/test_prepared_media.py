"""Media prepared ahead: built before it is needed, then claimed or thrown away.

A playlist prepares its next media in the last moments of the entry before
(PrepareMediaOutput()), and a MultiSync remote prepares what its master
says comes next. A prepare is claimed when that media starts, and one that
is never claimed is thrown away a few seconds later, as it holds a decoder
and keeps the display up.

Runs anywhere, Docker included: the display is the fake card of fakedrm.c
and the kmssink fakekms.c (test_video_display).
"""

import os
import re
import socket
import time

import fakedrm
import shims
from audio import write_tone_wav
from show import status
from test_video import make_video
from test_video_display import CONNECTOR, display_events, media_entry


def test_a_prepare_claimed_at_once_plays(fppd, audio):
    """A MultiSync remote told to prepare a song and, right behind that, to
    open and start it plays the song: its position moves on. The prepare's
    move to PAUSED is held 1.5 s here (slowstate.c), as a slow element's
    would be, so the start comes well before it.

    Regression: 342cb480f. Prepare() returned before its thread had set the
    pipeline to PAUSED, so a claim that came at once set it PLAYING first,
    and the prepare's PAUSED then froze the song where it was."""
    from multisync import PORT, sync_packet
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 10)
    mark = os.path.join(fppd.media, "tmp", "paused-held")
    fppd.settings(fppMode="remote", DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    fppd.start(preload=[shims.build("slowstate.c")],
               extra_env={"SLOWSTATE_STATE": "3", "SLOWSTATE_THREAD": "FPP-GstPrepare",
                          "SLOWSTATE_MS": "1500", "SLOWSTATE_MARK": mark})
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    try:
        time.sleep(2)
        send("prepare", "media", 0, 0.0, "Song.wav")
        fppd.wait_for(lambda: re.search(r"Preparing \S*Song\.wav for slot 1", fppd.log()), timeout=5, interval=0.05,
                      what="the remote to prepare the song")
        send("open", "media", 0, 0.0, "Song.wav")
        send("start", "media", 0, 0.0, "Song.wav")
        fppd.wait_for(lambda: re.search(r"GStreamer started playing: \S*Song\.wav", fppd.log()), timeout=10,
                      what="the remote to play the song")
        assert re.search(r"Using \S*Song\.wav prepared for slot 1", fppd.log()), \
            "precondition: the song started from the prepare"
        time.sleep(3)  # the held PAUSED, if it is still to come, has come
        first = float(status(fppd).get("seconds_played", 0) or 0)
        time.sleep(2)
        later = float(status(fppd).get("seconds_played", 0) or 0)
        assert later - first >= 1.5, f"the song stopped moving: {first:.1f} s, then {later:.1f} s 2 s later"
        send("stop", "media", 0, 7.0, "Song.wav")
    finally:
        sock.close()


def test_a_prepare_on_another_slot_leaves_the_first_one_s_expiry_alone(fppd, audio):
    """A video prepared on slot 1, then a song for slot 2 prepared as an
    insert (Insert Playlist After Current, Remote Falcon's requests) plays
    in its place: the video's prepare, which nothing plays during the 12 s
    song, is thrown away a few seconds in, and the display it was keeping
    up closes during the song.

    Regression: 38ced3a97. Every prepare's expiry was a timer of one name,
    and a timer of the same name replaces the last, so slot 2's prepare
    cancelled slot 1's expiry: the unplayed video held its decoder and kept
    the display up through the whole song."""
    make_video(os.path.join(fppd.media, "videos", "First.mkv"), seconds=4)
    make_video(os.path.join(fppd.media, "videos", "Next.mkv"), seconds=2)
    write_tone_wav(os.path.join(fppd.media, "music", "Request.wav"), 12)
    request = dict(media_entry("Request.wav", "--Disabled--"), streamSlot=2)
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [],
                                       "leadOut": [], "mainPlaylist": [media_entry("First.mkv"),
                                                                       media_entry("Next.mkv")]})
    fppd.write("playlists/Request.json", {"name": "Request", "repeat": 0, "loopCount": 0, "leadIn": [],
                                          "leadOut": [], "mainPlaylist": [request]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: "Preparing Next.mkv for slot 1" in fppd.log(), timeout=20, interval=0.1,
                  what="the next video to be prepared")
    fppd.command("Insert Playlist After Current", "Request", "0", "0")
    fppd.wait_for(lambda: "Preparing Request.wav for slot 2" in fppd.log(), timeout=5, interval=0.1,
                  what="the inserted song to be prepared on slot 2")
    fppd.wait_for(lambda: "GStreamer started playing: Request.wav" in fppd.log(), timeout=10,
                  what="the inserted song")
    started = time.monotonic()
    fppd.wait_for(lambda: "Discarding Next.mkv prepared for slot 1" in fppd.log() or
                  time.monotonic() - started > 10, timeout=15, interval=0.2, what="10 s of the song")
    assert "Discarding Next.mkv prepared for slot 1" in fppd.log(), \
        "the video prepared on slot 1 was still held 10 s into the song"
    assert "GStreamer started playing: Next.mkv" not in fppd.log(), "precondition: the song still plays"
    fppd.wait_for(lambda: any(e == "stop" for e, *_ in display_events(fppd)), timeout=3, interval=0.2,
                  what="the display to close once nothing held it")
