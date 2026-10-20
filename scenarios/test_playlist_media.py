"""Playlist entries that play media, against a PipeWire null sink (the
`audio` fixture): the sequence+media ("both") entry's media offset and
media that fails to start, and random media across pause and resume."""

import os
import time

from audio import write_tone_wav
from capture import UdpCapture
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync
from show import CHANNELS, ddp_output, playlist, status
from test_media_commands import sounding_seconds


def both(seq, media):
    return {"type": "both", "enabled": 1, "playOnce": 0, "sequenceName": seq, "mediaName": media}


def song(fppd, seconds):
    """Song.fseq (unique frames: each one names its index) and Song.wav,
    `seconds` long, and a DDP output for the lights. Returns the frames."""
    frames = unique_frames(seconds * 20, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), seconds)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    return frames


def test_media_offset_under_a_frame_starts_the_lights(fppd, audio):
    """With a media offset shorter than one frame (10 ms, 50 ms frames) a
    sequence+media entry's lights start with its media.

    Regression: 3a1f0fd8c. "offset - frame time" was worked out unsigned,
    so an offset under a frame came to about 4e9 ms and the sequence never
    started: sound, no lights.
    """
    index = {f: i for i, f in enumerate(song(fppd, 4))}
    fppd.settings(globalMediaOffset="10")
    fppd.write("playlists/Song.json", playlist("Song", [both("Song.fseq", "Song.wav")]))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the song")
        # Opening the sequence already shows its first frame; a started one
        # moves on.
        fppd.wait_for(lambda: rx.last() is not None and index.get(rx.last(), 0) >= 10, timeout=3,
                      what="the sequence's lights to play")
    fppd.command("Stop Now")


def test_media_offset_sends_the_multisync_start_once(fppd, audio):
    """With a media offset, a MultiSync master sends its remotes one media
    start for the song, once the offset has passed.

    Regression: c236c1523. Nothing recorded that the delayed start had been
    sent, so from the offset on it went out again every main-loop tick for
    the whole song, and remotes restarted their media on each one.
    """
    remote = "127.0.0.2"
    song(fppd, 4)
    fppd.settings(globalMediaOffset="200", MultiSyncEnabled="1", MultiSyncRemotes=remote)
    fppd.write("playlists/Song.json", playlist("Song", [both("Song.fseq", "Song.wav")]))
    with UdpCapture(PORT, remote) as cap:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the song")
        time.sleep(3)
        packets = cap.snapshot()
    fppd.command("Stop Now")
    starts = [s for s in (parse_sync(t, p) for t, _, _, p in packets)
              if s and s.file_type == "media" and s.action == "start"]
    assert len(starts) == 1, f"{len(starts)} media start packets for one song"


def test_media_back_for_the_next_pass_after_a_failed_start(fppd, audio):
    """A repeating sequence+media entry whose media is missing on the first
    pass plays lights only then, and plays the media on a later pass once
    the file is there.

    Regression: 61da36435. A media start that failed once deleted the
    entry's media for good, so every later pass played without sound.
    """
    song(fppd, 2)
    wav = os.path.join(fppd.media, "music", "Song.wav")
    os.rename(wav, wav + ".later")
    fppd.write("playlists/Song.json", playlist("Song", [
        both("Song.fseq", "Song.wav"), {"type": "pause", "enabled": 1, "playOnce": 0,
                                        "duration": 3}], repeat=1))
    fppd.start()
    rec = audio.record()
    fppd.command("Start Playlist", "Song", "true", "false")
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "pause",
                  timeout=10, what="the first pass's pause")
    os.rename(wav + ".later", wav)
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("type") == "both",
                  timeout=10, what="the second pass")
    time.sleep(2.5)
    heard = sounding_seconds(rec.stop())
    fppd.command("Stop Now")
    assert heard >= 1.0, f"heard {heard:.2f} s of the second pass's 2 s of media"


def test_resume_keeps_the_random_pick(fppd, audio):
    """Pause then Resume of a random audio entry carries on with the song it
    was playing, not a new random pick.

    Regression: 96e4acef3. Resume reopened the media through the same path
    as a start, which picks the next random file: a different song.
    """
    for k in range(6):
        write_tone_wav(os.path.join(fppd.media, "music", f"Tone{k}.wav"), 20, freq=400 + 100 * k)
    fppd.write("playlists/Random.json", playlist("Random", [{
        "type": "media", "enabled": 1, "playOnce": 0, "fileMode": "randomAudio"}]))
    fppd.start()
    fppd.command("Start Playlist", "Random", "false", "false")
    song_now = lambda: status(fppd).get("current_song")
    first = fppd.wait_for(song_now, what="a song to play")
    for _ in range(3):
        time.sleep(1)
        fppd.command("Pause Playlist")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", what="paused")
        fppd.command("Resume Playlist")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
        time.sleep(0.5)
        assert song_now() == first, f"resumed with {song_now()!r}, was playing {first!r}"
    fppd.command("Stop Now")
