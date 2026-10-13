"""Media playback through PipeWire, heard by recording a null sink.

The `audio` fixture runs a PipeWire of the scenario's own (audio.py), and
fppd plays into it exactly as it plays into a sound card on a device.
"""

import os
import statistics
import time

from audio import RATE, rms_windows, write_tone_wav
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist, status
from frames import analyze


def sounding(samples, threshold=0.1):
    """(first, last) second of the recording with sound above threshold."""
    idx = [i for i, x in enumerate(samples) if abs(x) > threshold]
    return (idx[0] / RATE, idx[-1] / RATE) if idx else (None, None)


def test_play_media_plays_the_whole_file(fppd, audio):
    """Play Media sends the whole file to the audio output at unity gain: a
    3 s, 1 kHz tone at half scale comes out 3 s long, at the same level and
    pitch, then silence and an idle player."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 3, freq=1000, amplitude=0.5)
    fppd.start()
    rec = audio.record()
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    time.sleep(4.5)
    samples = rec.stop()

    first, last = sounding(samples)
    assert first is not None, "nothing was heard"
    assert 2.8 <= last - first <= 3.2, f"heard {last - first:.2f} s of a 3 s file"
    body = samples[int((first + 0.5) * RATE):int((last - 0.5) * RATE)]
    level = statistics.fmean(r for _, r in rms_windows(body, 0.1))
    if audio.unity:
        assert 0.32 <= level <= 0.39, f"level {level:.3f}, expected 0.354 (0.5 sine at unity gain)"
    else:
        assert level > 0.01, f"level {level:.4f}: nothing audible at the device's volume"
    crossings = sum(1 for a, b in zip(body, body[1:]) if a < 0 <= b)
    pitch = crossings / (len(body) / RATE)
    assert 980 <= pitch <= 1020, f"pitch {pitch:.0f} Hz, expected 1000"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the player to go idle after the media")


def test_sequence_and_media_play_together(fppd, audio):
    """A sequence+media playlist entry plays both to the end, and they stay
    together: audio bursts once a second line up with the sequence's frame
    for that second without drifting apart.

    How closely they hold is only meaningful against a real clock. On a
    device (run-local.sh) the bound is 75 ms: FPP corrects the lights to
    whole frames (50 ms), so less than that cannot be corrected. In a
    container PipeWire's null sink runs on a VM timer that wanders 100-200
    ms against the monotonic clock on its own, so there the spread is only
    printed; the frame and burst checks still apply. The long-song drift
    against real sound cards is measured with run-local.sh --host-audio."""
    secs = 10
    frames = unique_frames(secs * 20, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs,
                   bursts=[(k, 0.1) for k in range(1, secs)])
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        rec = audio.record()
        fppd.command("Start Playlist", "Song", "false", "false")
        time.sleep(secs + 2)
        samples = rec.stop()
        received = rx.snapshot()

    # The media is the clock: sync repeats or skips the odd frame to follow
    # it, and the entry ends when the audio does, so the last frame or two
    # may not show. Nothing may be corrupted or go backwards.
    # In a container the audio's VM clock runs ahead of the lights by up to
    # a few hundred ms (see below), so the end can come half a second early.
    in_container = os.path.exists("/etc/fpp/container")
    tail = 10 if in_container else 3
    r = analyze(frames, received)
    assert r.unknown == 0 and r.backwards == 0, r.summary()
    assert r.first_index == 0 and r.last_index >= len(frames) - 1 - tail, r.summary()
    assert r.distinct >= 0.95 * len(frames), r.summary()
    onsets, quiet = [], 0
    for i, x in enumerate(samples):
        if abs(x) > 0.1 and quiet > RATE * 0.5:
            onsets.append(rec.started + i / RATE)
        quiet = 0 if abs(x) > 0.1 else quiet + 1
    assert len(onsets) == secs - 1, f"heard {len(onsets)} of {secs - 1} audio bursts"
    first_seen = {}
    for t, d in received:
        i = lookup.get(d[:CHANNELS])
        if i is not None:
            first_seen.setdefault(i, t)
    offsets = [(onset - first_seen[k * 20]) * 1000 for k, onset in zip(range(1, secs), onsets)]
    spread = max(offsets) - min(offsets)
    print(f"audio minus lights, ms: {[round(o) for o in offsets]}; spread {spread:.0f} ms")
    if not in_container:
        assert spread < 75, f"media and lights wandered {spread:.0f} ms apart over {secs} s"


def test_long_song_stays_locked_to_the_sound_card(fppd, audio):
    """Over a long song, the lights follow the sound card's clock, not the
    system's.

    A card's sample clock is never exactly nominal (tens to hundreds of ppm
    off the system clock is normal). FPP corrects the lights to the media
    position in whole frames, so the gap between them may wander by about a
    frame, but it must not grow steadily with the song: that is drift no
    correction is acting on, and it reaches 100 ms within minutes. Nor may
    it wander by much more than a frame once playback has settled.

    Only meaningful against a real card: runs with run-local.sh
    --host-audio (FPP_TESTS_HOST_AUDIO). FPP_TESTS_LONG_SONG sets the length
    in seconds (default 300)."""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = int(os.environ.get("FPP_TESTS_LONG_SONG", "300"))
    frames = unique_frames(secs * 20, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs, amplitude=0.3,
                   bursts=[(k, 0.1) for k in range(1, secs, 2)])
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        # 8 kHz is plenty to time 1 kHz bursts and keeps the analysis of a
        # five-minute song quick on a single-core board.
        rec = audio.record(rate=8000)
        fppd.command("Start Playlist", "Song", "false", "false")
        time.sleep(secs + 3)
        samples = rec.stop()
        received = rx.snapshot()

    # Audio time is the card's sample count; light time is the monotonic
    # clock. Both are taken relative to the first burst.
    threshold = max(abs(x) for x in samples) * 0.3
    onsets, quiet = [], 0
    for i, x in enumerate(samples):
        if abs(x) > threshold and quiet > rec.rate * 0.5:
            onsets.append(i / rec.rate)
        quiet = 0 if abs(x) > threshold else quiet + 1
    first_seen = {}
    for t, d in received:
        i = lookup.get(d[:CHANNELS])
        if i is not None:
            first_seen.setdefault(i, t)
    pairs = [(onsets[n], first_seen[(1 + 2 * n) * 20]) for n in range(len(onsets))
             if (1 + 2 * n) * 20 in first_seen]
    assert len(pairs) > secs // 4, f"only {len(pairs)} bursts matched to frames"
    a0, l0 = pairs[0]
    xs = [a - a0 for a, _ in pairs]
    drift = [((l - l0) - (a - a0)) * 1000 for a, l in pairs]
    mx, my = statistics.fmean(xs), statistics.fmean(drift)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, drift)) / sum((x - mx) ** 2 for x in xs)
    ppm = slope * 1000  # ms per s -> ppm
    print(f"lights minus audio over {secs} s, every 20 s (ms): "
          f"{[round(d) for d in drift[::10]]}; trend {ppm:.0f} ppm")
    assert abs(ppm) < 50, \
        f"the lights drift {ppm:.0f} ppm against the sound card ({drift[-1]:.0f} ms by the end): " \
        "nothing is keeping them on the card's clock"
    # And no wandering: once playback has settled, the gap stays within about
    # a frame and a half -- FPP corrects in whole frames, so a frame of
    # wander is expected, more is not.
    settled = [d for x, d in zip(xs, drift) if x >= 20]
    wander = max(settled) - min(settled)
    assert wander <= 75, \
        f"after the first 20 s the gap between lights and sound wandered over {wander:.0f} ms"
