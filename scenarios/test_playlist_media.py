"""Playlist entries that play media, against a PipeWire null sink (the
`audio` fixture): the sequence+media ("both") entry's media offset and
media that fails to start, random media across pause and resume, the
media details each entry hands to plugins, and the length of a fragmented
MP4."""

import json
import os
import struct
import subprocess
import time

import pytest

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

    - Song.wav, 4 s, which TagLib reads: length 4, seconds 4, 48000 Hz,
      mono.
    - Missing.wav, a file that isn't there, played next: no details at all.
    - Tone.au, 2 s, a Sun audio file fppd plays but TagLib cannot open,
      with a duration of 2.0 s in config/media_durations.cache (what the
      file manager's ffprobe leaves there): length 2 and seconds 2 from
      the cache, and nothing else. While it plays, fppd's status counts
      down from its own 2 s: elapsed plus remaining is 1 or 2 s (each is
      whole seconds, rounded down), and time_remaining says the same.

    Regression: 1a98c6014. ParseMedia() returned before clearing the shared
    details when the file was missing, so the plugin got Song.wav's length,
    rate and channels for Missing.wav; and Clear() left the length in ms
    behind, and the cache is taken only over a shorter length, so for
    Tone.au the cache's 2 s lost to Song.wav's 4000 ms still there and no
    length was reported. The same uncleared field, on a fresh object, gave
    a media entry's duration and time remaining stack garbage; that is not
    checked, as what the stack holds varies (it was harmless in the runs
    tried).

    Regression: be1f0c19c. ParseMedia() worked out
    seconds and minutes into locals that shadowed the members, so for a
    file TagLib reads they stayed at 0 and the plugin got no "seconds".

    Regression: 560224349. The media entry took the
    slot's media position as a lower bound for its length, and nothing
    reset it between entries, so Tone.au took Song.wav's 4 s end position
    as its length: 3 or 4 s for elapsed plus remaining.
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
    # Tone.au's status, sampled until the playlist ends.
    playing = []

    def ended():
        st = status(fppd)
        if st.get("status_name") == "playing" and st.get("current_song") == "Tone.au":
            playing.append(st)
        return st.get("status_name") == "idle"

    fppd.wait_for(ended, timeout=20, interval=0.1, what="the playlist to end")
    calls = media_callbacks(d)
    assert [c.get("Media") for c in calls] == ["Song.wav", "Missing.wav", "Tone.au"], calls
    song, missing, tone = calls
    # No "minutes": the plugin is only given the fields that aren't 0.
    assert (song.get("length"), song.get("seconds"), song.get("minutes"),
            song.get("sampleRate"), song.get("channels")) \
        == ("4", "4", None, "48000", "1"), song
    assert missing == {"type": "media", "Sequence": "", "Media": "Missing.wav"}, missing
    assert tone == {"type": "media", "Sequence": "", "Media": "Tone.au",
                    "length": "2", "seconds": "2"}, tone
    assert playing, "no status while Tone.au played"
    # 0 + 0 before the length is known; Song.wav's stale 4 s gives 3 or 4.
    totals = []
    for st in playing:
        elapsed, remaining = int(st["seconds_played"]), int(st["seconds_remaining"])
        totals.append(elapsed + remaining)
        assert elapsed + remaining in (0, 1, 2), (elapsed, remaining, st.get("time_remaining"))
        assert st.get("time_remaining") == f"00:{remaining:02d}", st.get("time_remaining")
    assert any(totals), f"Tone.au never showed its length: {totals}"


def write_fragmented_m4a(path, seconds):
    """`seconds` of a 48 kHz mono tone as MP3 in a fragmented MP4: an ftyp,
    a moov with no samples and a length of zero, then moof/mdat pairs of
    0.5 s each, and nothing else that gives the length away. GStreamer's
    mp4mux writes it, and also writes the length in an mehd box in the moov
    and in an mfra index at the end, which some muxers leave out (ffmpeg's
    empty_moov, a live recording); the mehd is renamed to a free box and the
    mfra cut off. Returns the top-level boxes."""
    r = subprocess.run(["gst-launch-1.0", "-q", "audiotestsrc", f"num-buffers={seconds * 48000 // 1024}",
                        "samplesperbuffer=1024", "!", "audio/x-raw,rate=48000,channels=1", "!",
                        "audioconvert", "!", "lamemp3enc", "!", "mpegaudioparse", "!",
                        "mp4mux", "fragment-duration=500", "streamable=true", "!",
                        "filesink", f"location={path}"], capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make a fragmented MP4 (lamemp3enc, mp4mux): {r.stderr.strip()[-300:]}")
    with open(path, "rb") as f:
        data = bytearray(f.read())
    boxes, i = [], 0
    while i + 8 <= len(data):
        size, kind = struct.unpack(">I4s", data[i:i + 8])
        if kind == b"mfra":
            del data[i:]
            break
        boxes.append(kind.decode("latin-1"))
        i += size
    assert data.count(b"mehd") == 1, "no single mehd box in the moov"
    at = data.index(b"mehd")
    data[at:at + 4] = b"free"
    with open(path, "wb") as f:
        f.write(data)
    return boxes


def test_a_fragmented_mp4s_length_comes_from_the_duration_cache(fppd, audio):
    """A media entry playing Frag.m4a, an 8 s fragmented MP4 (an empty moov,
    then moof/mdat fragments, with no mehd or mfra to give the length)
    whose length is 8.0 s in config/media_durations.cache (what the file
    manager's ffprobe leaves there), has its time remaining counted down
    from 8 s: once 2 s have played, elapsed plus remaining in fppd's status
    is 7 or 8 s (each is whole seconds, rounded down).

    Regression: e52e22cad. The header, all TagLib reads, gives a fragmented
    file a length of zero, and GStreamer learns the length only as it reads
    the fragments, so the entry's length followed its position and the time
    remaining sat at 0 for the whole track.
    """
    m4a = os.path.join(fppd.media, "music", "Frag.m4a")
    boxes = write_fragmented_m4a(m4a, 8)
    assert boxes[:3] == ["ftyp", "moov", "moof"] and "mdat" in boxes, boxes
    fppd.write("config/media_durations.cache",
               {"Frag.m4a": {"filesize": os.path.getsize(m4a), "duration": "8.000000"}})
    fppd.write("playlists/Frag.json", playlist("Frag", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Frag.m4a"}]))
    fppd.start()
    fppd.command("Start Playlist", "Frag", "false", "false")

    def two_seconds_in():
        st = status(fppd)
        return st if st.get("status_name") == "playing" and int(st.get("seconds_elapsed", 0)) >= 2 else None

    st = fppd.wait_for(two_seconds_in, timeout=15, interval=0.1, what="2 s of Frag.m4a to play")
    fppd.command("Stop Now")
    assert st.get("current_song") == "Frag.m4a", st
    elapsed, remaining = int(st["seconds_elapsed"]), int(st["seconds_remaining"])
    assert elapsed + remaining in (7, 8), (elapsed, remaining, st.get("time_remaining"))
