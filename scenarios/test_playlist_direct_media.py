"""Playlist entries that pick media by name: a media file started by its own
name as if it were a playlist, and a random media pick narrowed by a file
name prefix."""

import os
import shutil
import time

import pytest

from audio import write_tone_wav
from show import playlist, status
from test_media_commands import sounding_seconds


@pytest.mark.parametrize("name", ["Tone.wav", "Tone.mp3", "Bars.mkv"])
def test_a_media_file_started_by_name_plays_as_a_playlist_of_its_own(fppd, audio, name):
    """Start Playlist with a media file's name (an audio file or a video,
    nothing but the file name) plays that file: the status names it as the
    playlist, its sound reaches the audio output, and the player goes idle
    when it ends. Tone.mp3 is a WAV under an .mp3 name: fppd picks the
    player from the name, GStreamer from the content.

    Regression: 3b6edcf6d. Only .mp3 and .mp4 names were taken for media; any
    other (a .wav, a .mkv, a .flac) was read as a playlist file of that name,
    which isn't there, and nothing started.

    Also f8369608d: the status page's choice of a media file is a Start
    Playlist of its name (the page's list of media is checked in
    web/tests/status-page-media.spec.ts), and the .mp3 case is its own.
    """
    import test_video
    music = os.path.join(fppd.media, "music")
    if name == "Bars.mkv":
        test_video.make_video(os.path.join(fppd.media, "videos", name), seconds=3)
    else:
        write_tone_wav(os.path.join(music, "Tone.wav"), 3, amplitude=0.5)
        if name != "Tone.wav":
            shutil.move(os.path.join(music, "Tone.wav"), os.path.join(music, name))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    rec = audio.record()
    fppd.command("Start Playlist", name, "false", "false")
    st = fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == name
                       and status(fppd), timeout=10, what=f"{name} to be the playlist")
    assert st.get("status_name") == "playing", st
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.2,
                  what=f"{name} to end")
    heard = sounding_seconds(rec.stop(), threshold=0.02)
    assert heard >= 1.5, f"heard {heard:.2f} s of {name}"


def test_random_media_with_a_prefix_picks_only_files_starting_with_it(fppd, audio):
    """A random-audio entry over a music folder of four Alpha files and two
    Beta files, with the prefix "Beta", plays only Beta files in twelve
    starts; the same entry without a prefix (the control) plays Alpha ones
    too.

    Regression: 4aa3946df. A random entry could not be narrowed by file name:
    the prefix field was not read, so a show that kept its seasonal songs
    among the rest played the others as well."""
    for n in ("Alpha1", "Alpha2", "Alpha3", "Alpha4", "Beta1", "Beta2"):
        write_tone_wav(os.path.join(fppd.media, "music", f"{n}.wav"), 0.3)
    entry = {"type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio"}
    fppd.write("playlists/Beta.json", playlist("Beta", [dict(entry, mediaPrefix="Beta")]))
    fppd.write("playlists/Any.json", playlist("Any", [dict(entry)]))
    fppd.start()

    def picks(name, count=12):
        """The song each of `count` starts of the playlist played. The pick
        is seeded from the clock in seconds, so the starts are a second
        apart."""
        got = []
        for _ in range(count):
            fppd.command("Start Playlist", name, "false", "false")
            song = fppd.wait_for(lambda: status(fppd).get("status_name") == "playing"
                                 and status(fppd).get("current_song"), timeout=10, interval=0.02,
                                 what=f"{name} to play a song")
            got.append(song)
            fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10, interval=0.05,
                          what=f"{name} to end")
            time.sleep(1)
        return got

    beta = picks("Beta")
    assert all(s.startswith("Beta") for s in beta), f"the Beta playlist played {beta}"
    any_ = picks("Any")
    assert any(s.startswith("Alpha") for s in any_), f"the control never played an Alpha file: {any_}"


def test_random_media_entries_in_one_playlist_do_not_all_pick_the_same_song(fppd, audio):
    """Ten random-audio entries in one playlist, over six songs, do not all
    play the same one.

    Not fixed on master: PlaylistEntryMedia seeds its pick with the time in
    seconds (PlaylistEntryImage adds the entry's address), so entries loaded
    together draw the same number. Found while writing the prefix test."""
    for n in range(6):
        write_tone_wav(os.path.join(fppd.media, "music", f"Song{n}.wav"), 0.3)
    entry = {"type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio"}
    fppd.write("playlists/Ten.json", playlist("Ten", [dict(entry) for _ in range(10)]))
    fppd.start()
    seen = set()
    fppd.command("Start Playlist", "Ten", "false", "false")

    def done():
        st = status(fppd)
        if st.get("status_name") == "playing" and st.get("current_song"):
            seen.add(st["current_song"])
        return st.get("status_name") == "idle" and seen
    fppd.wait_for(done, timeout=30, interval=0.05, what="the playlist to play out")
    assert len(seen) > 1, f"ten random entries all played {seen}"
