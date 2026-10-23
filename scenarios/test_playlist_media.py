"""Playlist entries that play media, against a PipeWire null sink (the
`audio` fixture): the sequence+media ("both") entry's media offset and
media that fails to start, random media across pause and resume, and the
media details each entry hands to plugins."""

import json
import os
import time

from audio import write_tone_wav
from capture import UdpCapture
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from multisync import PORT, parse_sync
from show import CHANNELS, ddp_output, playlist, status
from test_media_commands import sounding_seconds
from test_plugin_scripts import events, plugin


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


def write_tone_au(path, seconds, freq=1000):
    """A 48 kHz mono 16-bit tone as a Sun .au file: a format fppd plays
    (GStreamer's auparse) and TagLib cannot open."""
    import math
    import struct
    rate = 48000
    total = int(seconds * rate)
    pcm = b"".join(struct.pack(">h", int(16383 * math.sin(2 * math.pi * freq * i / rate)))
                   for i in range(total))
    with open(path, "wb") as f:
        # magic, data offset, data size, encoding 3 (16-bit linear), rate, channels
        f.write(struct.pack(">4sIIIII", b".snd", 24, len(pcm), 3, rate, 1))
        f.write(pcm)
    return path


def media_callbacks(d):
    """The data of each media event a plugin heard, in order."""
    return [json.loads(line[len("media --data "):]) for line in events(d)
            if line.startswith("media --data ")]


def test_media_details_are_cleared_for_each_entry(fppd, audio):
    """A plugin's media callback for each media entry of a playlist carries
    that entry's own details, never the entry before's:

    - Song.wav, 4 s, which TagLib reads: length 4, 48000 Hz, mono.
    - Missing.wav, a file that isn't there, played next: no details at all.
    - Tone.au, 2 s, a Sun audio file fppd plays but TagLib cannot open,
      with a duration of 2.0 s in config/media_durations.cache (what the
      file manager's ffprobe leaves there): length 2 and seconds 2 from
      the cache, and nothing else.

    Regression: 1a98c6014. ParseMedia() returned before clearing the shared
    details when the file was missing, so the plugin got Song.wav's length,
    rate and channels for Missing.wav; and Clear() left the length in ms
    behind, and the cache is taken only over a shorter length, so for
    Tone.au the cache's 2 s lost to Song.wav's 4000 ms still there and no
    length was reported. The same uncleared field, on a fresh object, gave
    a media entry's duration and time remaining stack garbage; that is not
    checked, as what the stack holds varies (it was harmless in the runs
    tried). Time remaining is left out
    for another reason too: after Song.wav, Tone.au reports Song.wav's
    length on master (PROBLEMS.md 25).
    """
    d = plugin(fppd, types="media")
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), 4)
    au = write_tone_au(os.path.join(fppd.media, "music", "Tone.au"), 2)
    fppd.write("config/media_durations.cache",
               {"Tone.au": {"filesize": os.path.getsize(au), "duration": "2.000000"}})
    media = lambda name: {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": name}
    fppd.write("playlists/Songs.json", playlist("Songs", [
        media("Song.wav"), media("Missing.wav"), media("Tone.au")]))
    fppd.start()
    fppd.command("Start Playlist", "Songs", "false", "false")
    fppd.wait_for(lambda: len(media_callbacks(d)) >= 3, timeout=20, interval=0.1,
                  what="the media callback for Tone.au")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                  interval=0.1, what="the playlist to end")
    calls = media_callbacks(d)
    assert [c.get("Media") for c in calls] == ["Song.wav", "Missing.wav", "Tone.au"], calls
    song, missing, tone = calls
    # Not "seconds": ParseMedia() never sets it for a file TagLib reads
    # (PROBLEMS.md 24), so the plugin gets none.
    assert (song.get("length"), song.get("sampleRate"), song.get("channels")) \
        == ("4", "48000", "1"), song
    assert missing == {"type": "media", "Sequence": "", "Media": "Missing.wav"}, missing
    assert tone == {"type": "media", "Sequence": "", "Media": "Tone.au",
                    "length": "2", "seconds": "2"}, tone
