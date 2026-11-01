"""A MultiSync remote with its own per-host audio: told to play Song.wav, it
plays music/Song-<HostName>.wav when that exists, and hands the details of
that file to plugins. Heard on the audio fixture's null sink."""

import os
import socket
import time

from audio import write_tone_wav
from multisync import PORT, sync_packet
from test_media_commands import sounding_seconds
from test_playlist_media import media_callbacks
from test_plugin_scripts import plugin


def play_as_remote(fppd, audio, name, seconds=4):
    """Open and start `name` from a master and keep syncing it for `seconds`;
    the seconds of sound heard on the sink."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    rec = audio.record()
    try:
        send("open", "media", 0, 0, name)
        send("start", "media", 0, 0, name)
        began = time.monotonic()
        while time.monotonic() - began < seconds:
            send("sync", "media", 0, time.monotonic() - began, name)
            time.sleep(0.25)
        send("stop", "media", 0, seconds, name)
        time.sleep(0.5)
    finally:
        sock.close()
    return sounding_seconds(rec.stop())


def own_and_host_copy(fppd):
    """Song.wav, 6 s, and Song-box1.wav, 2 s: the host copy is told apart
    by how long it sounds and by the length a plugin is given for it."""
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 6)
    write_tone_wav(os.path.join(fppd.media, "music", "Song-box1.wav"), 2)
    fppd.settings(fppMode="remote", HostName="box1", LogLevel_MediaOut="debug")


def test_remote_plays_its_own_per_host_audio_for_the_masters_file(fppd, audio):
    """A remote named box1 told by MultiSync to play Song.wav plays
    music/Song-box1.wav (2 s of sound in a 4 s sync) rather than its Song.wav
    (6 s), and the file it opened is the per-host one; with a different
    HostName the same files play Song.wav.

    Regression: e9465c084. The remote looked only for the master's file name,
    so each remote could not be given a unique audio file of its own."""
    own_and_host_copy(fppd)
    d = plugin(fppd, types="media")
    fppd.start()
    heard = play_as_remote(fppd, audio, "Song.wav")
    opened = [c.get("Media", "") for c in media_callbacks(d)]
    assert opened and opened[0].endswith("Song-box1.wav"), f"the remote opened {opened}"
    assert 1.2 <= heard <= 3.0, f"the per-host 2 s file sounded {heard:.2f} s"


def test_remote_without_a_per_host_file_plays_the_masters_name(fppd, audio):
    """The control for the per-host lookup: a remote whose HostName has no
    Song-<HostName>.wav plays its Song.wav (6 s) for the 4 s sync."""
    own_and_host_copy(fppd)
    fppd.settings(HostName="other")
    d = plugin(fppd, types="media")
    fppd.start()
    heard = play_as_remote(fppd, audio, "Song.wav")
    opened = [c.get("Media", "") for c in media_callbacks(d)]
    assert opened and opened[0].endswith("Song.wav") and "box1" not in opened[0], f"the remote opened {opened}"
    assert heard >= 3.2, f"Song.wav sounded {heard:.2f} s"


def test_media_details_of_a_remotes_per_host_file_reach_plugins(fppd, audio):
    """The remote's media callback for the per-host file, which fppd names
    by its full path, carries that file's own details: length 2, 48000 Hz,
    mono, and fppd logs no file it could not find.

    Regression: b88a911f9. ParseMedia() took every name as relative to the
    music or video folder, so a full path was looked up inside them, found
    nothing, and the plugin was given no details for the file."""
    own_and_host_copy(fppd)
    d = plugin(fppd, types="media")
    fppd.start()
    play_as_remote(fppd, audio, "Song.wav", seconds=1.5)
    calls = media_callbacks(d)
    assert calls, "no media callback"
    c = calls[0]
    assert c.get("Media", "").endswith("Song-box1.wav"), c
    assert (c.get("length"), c.get("sampleRate"), c.get("channels")) == ("2", "48000", "1"), c
    assert "Unable to find" not in fppd.log(), [l for l in fppd.log().splitlines() if "Unable to find" in l]
