"""Media playback through PipeWire, heard by recording a null sink.

The `audio` fixture runs a PipeWire of the scenario's own (audio.py), and
fppd plays into it exactly as it plays into a sound card on a device.
"""

import os
import statistics
import time
import urllib.error

import pytest

from audio import RATE, card_position, rms_windows, write_tone_wav
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
    device (run-local.sh) the bound is 25 ms: media sync closes the timing
    error between each frame and the media position continuously, not in
    whole frames (f2d25dc05; it was 75 ms, a frame and a half, before). In a
    container PipeWire's null sink runs on a VM timer that wanders 100-200
    ms against the monotonic clock on its own, so there the spread is only
    printed; the frame and burst checks still apply. The long-song drift
    against real sound cards is measured with run-local.sh --host-audio.

    Regression: 240c53472 (run with --flavor tsan). The media status was a
    plain int, set from GStreamer's bus thread as the media ended and read
    by the playlist on the main loop: a data race TSan reports here."""
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
            onsets.append(rec.time_of(i))
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
        assert spread < 25, f"media and lights wandered {spread:.0f} ms apart over {secs} s"


def test_long_song_stays_locked_to_the_sound_card(fppd, audio):
    """Over a long song, the lights follow the sound card's clock, not the
    system's.

    A card's sample clock is never exactly nominal (tens to hundreds of ppm
    off the system clock is normal). Uncorrected, that is drift that reaches
    100 ms within minutes. The lights follow the media position, which runs
    on the card's clock, to a few ms (f2d25dc05), so the gap between them
    must stay within 25 ms from a few seconds into the song to its end.

    The gap is taken in real time: light frames by the system clock, audio
    by the recording's sample count scaled by the card's rate (fitted from
    ALSA's hardware pointer). Before 5c431d7d9 a slow card (Pi 5 I2S, -47
    ppm) let the sound fall 13 ms behind over 5 minutes; after it, 0 ms.

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
        # The card's real rate against the system clock: ALSA's hardware
        # pointer, read every half second through the song. Each reading is
        # only good to a period (the pointer moves once per interrupt), so the
        # rate comes from a straight-line fit through all of them.
        from audio import card_position, card_rate
        readings, positions = [], []
        end = time.monotonic() + secs + 3
        while time.monotonic() < end:
            p = card_position()
            if p:
                readings.append(p)
            # FPP's own idea of the media position, which the lights follow.
            t0 = time.monotonic()
            ms = fppd.get("/fppd/status").get("milliseconds_elapsed")
            t1 = time.monotonic()
            if isinstance(ms, int) and ms > 0:
                positions.append(((t0 + t1) / 2, ms / 1000))
            time.sleep(0.5)
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
    card_ppm = None
    same = [r for r in readings if readings and r[2] == readings[-1][2]]
    nominal = same[-1][3] if len(same) > 20 else None
    if nominal:
        ts = [r[1] for r in same]
        hw = [r[0] for r in same]
        mt, mh = statistics.fmean(ts), statistics.fmean(hw)
        rate = sum((t - mt) * (h - mh) for t, h in zip(ts, hw)) / sum((t - mt) ** 2 for t in ts)
        card_ppm = (rate / nominal - 1) * 1e6
        # The recording counts the card's samples at the nominal rate; in
        # real seconds each is (1 + card_ppm) times shorter.
        real = [((l - l0) - (a - a0) / (1 + card_ppm / 1e6)) * 1000 for a, l in pairs]
        print(f"card runs {card_ppm:+.1f} ppm against the system clock ({same[-1][2]}, "
              f"{len(same)} readings); lights minus audio in real time, every 20 s (ms): "
              f"{[round(d) for d in real[::10]]}")
    if len(positions) > 20:
        settled = positions[len(positions) // 10:-4]
        mt, mp = statistics.fmean(t for t, _ in settled), statistics.fmean(p for _, p in settled)
        rate = sum((t - mt) * (p - mp) for t, p in settled) / sum((t - mt) ** 2 for t, _ in settled)
        print(f"FPP's media position runs {(rate - 1) * 1e6:+.1f} ppm against the system clock")
    # What is heard against what is seen: both in real time. The recording
    # only counts the card's samples, so without the card's rate (a null
    # sink, which runs on the system clock) its count stands in for seconds.
    gap = real if card_ppm is not None else drift
    print(f"lights minus audio over {secs} s, every 20 s (ms): {[round(d) for d in gap[::10]]}")
    # Media sync used to correct in whole frames, so the gap wandered by up
    # to a frame and a half and only a separate drift figure could tell a
    # clock that wasn't followed. With the error closed continuously, any
    # drift shows as wander.
    settled = [d for x, d in zip(xs, gap) if x >= 2]
    wander = max(settled) - min(settled)
    assert wander <= 25, \
        f"from 3 s into the song the gap between lights and sound wandered over {wander:.0f} ms"


def test_offset_does_not_carry_across_songs(fppd, audio):
    """Back-to-back sequence+media songs each start with the same offset
    between lights and sound: whatever drift builds up within a song does not
    carry into the next. The persistent PipeWire output stream stays open
    across songs, so a queue that grew or drained inside it would show here
    as a steadily changing offset.

    Measured on a +432 ppm card, ten 1-minute songs: 244, 258, 244, 241, 253,
    233, 241, 256, 245, 240 ms -- no build-up. (The absolute value includes
    the recording's uncalibrated start; only the change matters.)

    Opt-in, real card only: run-local.sh --host-audio with FPP_TESTS_SONGS
    (number of songs; FPP_TESTS_SONG_SECONDS, default 60)."""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO") or not os.environ.get("FPP_TESTS_SONGS"):
        pytest.skip("needs a real card and FPP_TESTS_SONGS: run-local.sh --host-audio")
    SONGS = int(os.environ["FPP_TESTS_SONGS"])
    SECS = int(os.environ.get("FPP_TESTS_SONG_SECONDS", "60"))
    # Each song: a unique-frame sequence (frames encode song and index) and a
    # media file with one burst 1 s in.
    entries, starts = [], {}
    for n in range(SONGS):
        frames = unique_frames(SECS * 20, CHANNELS, first=20000 * n)
        starts[n] = frames[20]
        write_fseq(os.path.join(fppd.media, "sequences", f"S{n}.fseq"), frames)
        write_tone_wav(os.path.join(fppd.media, "music", f"S{n}.wav"), SECS, amplitude=0.3, bursts=[(1, 0.1)])
        entries.append({"type": "both", "enabled": 1, "playOnce": 0,
                        "sequenceName": f"S{n}.fseq", "mediaName": f"S{n}.wav"})
    fppd.write("playlists/Songs.json", playlist("Songs", entries))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    readings = []
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        rec = audio.record(rate=8000)
        fppd.command("Start Playlist", "Songs", "false", "false")
        end = time.monotonic() + SONGS * SECS + 10
        while time.monotonic() < end:
            p = card_position()
            if p: readings.append(p)
            time.sleep(0.5)
        samples = rec.stop()
        received = rx.snapshot()
    same = [r for r in readings if r[2] == readings[-1][2]]
    nominal = same[-1][3]
    ts = [r[1] for r in same]; hw = [r[0] for r in same]
    mt, mh = statistics.fmean(ts), statistics.fmean(hw)
    ppm = (sum((t - mt) * (h - mh) for t, h in zip(ts, hw)) / sum((t - mt) ** 2 for t in ts) / nominal - 1) * 1e6
    thr = max(abs(x) for x in samples) * 0.3
    onsets, quiet = [], 0
    for i, x in enumerate(samples):
        if abs(x) > thr and quiet > rec.rate * 0.5:
            onsets.append(rec.time_of(i, ppm))
        quiet = 0 if abs(x) > thr else quiet + 1
    lights = []
    for n in range(SONGS):
        t = next((t for t, d in received if d[:CHANNELS] == starts[n]), None)
        lights.append(t)
    offs = [round((l - a) * 1000) if l and a else None for l, a in zip(lights, onsets)]
    print(f"card {ppm:+.0f} ppm; lights minus audio at each song start (ms): {offs}")
    assert None not in offs, f"a song's start was not seen on the wire or heard: {offs}"
    assert max(offs) - min(offs) <= 25, \
        f"the offset moved {max(offs) - min(offs)} ms from song to song: {offs}"


def test_sequence_and_media_pause_resume_and_stop_together(fppd, audio):
    """A playlist entry with both a sequence and a song, paused, resumed and
    stopped: the sound and the lights stop and start together, status
    carries the elapsed time on from where it paused, and Stop Now silences
    and blanks both and goes idle.

    (Status reads 0 ms elapsed while a song is paused: Pause closes the media
    output, and PlaylistEntryMedia::GetElapsedMS() answers 0 without one
    before it reaches its paused case. Not asserted here until that is
    fixed.)"""
    secs = 10
    frames = unique_frames(secs * 20, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs, amplitude=0.5)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        rec = audio.record()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
        time.sleep(2.5)
        s = status(fppd)
        assert (s["current_sequence"], s["current_song"]) == ("Song.fseq", "Song.wav"), s
        held = s["milliseconds_elapsed"]
        assert held >= 1500, s

        paused_at = time.monotonic()
        fppd.command("Pause Playlist")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", what="paused")
        time.sleep(0.5)
        frames_while_paused = rx.count()
        time.sleep(1.5)
        assert rx.count() == frames_while_paused, "frames kept coming while paused"
        assert not any(rx.last()), "pausing did not blank the output"
        last_content = [lookup[d] for t, d in rx.snapshot() if t < paused_at and d in lookup][-1]

        resumed_at = time.monotonic()
        fppd.command("Resume Playlist")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing again")
        time.sleep(2)
        e = status(fppd)["milliseconds_elapsed"]
        assert held + 1000 <= e <= held + 1000 * (time.monotonic() - resumed_at) + 1000, \
            f"elapsed {e} ms two seconds after resuming, {held} ms before pausing"
        after = [lookup[d] for t, d in rx.snapshot(since=resumed_at) if d in lookup]
        assert after, "the lights did not come back after resuming"
        assert last_content - 2 <= after[0] <= last_content + 25, \
            f"the lights resumed at frame {after[0]}, paused after frame {last_content}"

        stopped_at = time.monotonic()
        fppd.command("Stop Now")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", what="idle after Stop Now")
        s = status(fppd)
        assert (s["current_sequence"], s["current_song"]) == ("", ""), s
        time.sleep(1)
        samples = rec.stop()
        assert not any(rx.last()), "Stop Now did not blank the output"

    def level(start, end):
        """The loudest 50 ms window between two monotonic times."""
        windows = [r for t, r in rms_windows(samples) if start <= rec.time_of(int(t * RATE)) <= end]
        return max(windows, default=0.0)

    floor = 0.1 if audio.unity else 0.005
    assert level(paused_at - 1.5, paused_at - 0.2) > floor, "nothing heard before the pause"
    assert level(paused_at + 0.5, resumed_at) < 0.01, "sound while paused"
    assert level(resumed_at + 0.7, stopped_at - 0.2) > floor, "nothing heard after resuming"
    assert level(stopped_at + 0.5, rec.ended) < 0.01, "sound after Stop Now"


def test_continuous_tone_has_no_dropouts(fppd, audio):
    """A song's audio reaches the card whole: no gaps, however far the card's
    crystal is from the system clock.

    The feed into the persistent PipeWire stream must keep pace with what the
    card takes. Fed at any other pace, a card that runs fast drains the feed's
    cushion and plays a quantum of silence each time it runs dry, and one that
    runs slow builds a queue that delays the sound more and more.

    Plays a continuous 1 kHz tone as a sequence+media song and looks for any
    2 ms stretch of the recording without it. Real card only (run-local.sh
    --host-audio); FPP_TESTS_TONE_SECONDS sets the length (default 120).

    Regression: 5c431d7d9 (feed paced by the card's clock). Hardware-verified
    with run-local.sh: on a +432 ppm AM62x PCM5102A cape, 5 gaps of 10 ms in
    120 s on the parent, none on the fix. A card near nominal rate (tens of
    ppm) only drops out every several minutes, so this needs a fast card or a
    long run to go red."""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = int(os.environ.get("FPP_TESTS_TONE_SECONDS", "120"))
    write_fseq(os.path.join(fppd.media, "sequences", "Tone.fseq"), unique_frames(secs * 20, CHANNELS))
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), secs, amplitude=0.3)
    fppd.write("playlists/Tone.json", playlist("Tone", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Tone.fseq", "mediaName": "Tone.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    rec = audio.record(rate=8000)
    fppd.command("Start Playlist", "Tone", "false", "false")
    time.sleep(secs + 3)
    samples = rec.stop()
    # 2 ms windows: two periods of the tone, so each holds its peak.
    win = 16
    peaks = [max(abs(x) for x in samples[i:i + win]) for i in range(0, len(samples) - win + 1, win)]
    level = statistics.median(peaks)
    sounding = [i for i, p in enumerate(peaks) if p > level * 0.5]
    assert sounding, "never heard the tone"
    first, last = sounding[0], sounding[-1]
    gaps, run = [], 0
    for i in range(first, last + 1):
        if peaks[i] < level * 0.2:
            run += 1
        elif run:
            gaps.append((i - run, run))
            run = 0
    print(f"tone heard for {(last - first) * 2 / 1000:.1f} s; gaps (s into the tone, ms): "
          f"{[(round((s - first) * 2 / 1000, 2), n * 2) for s, n in gaps]}")
    assert not gaps, f"{len(gaps)} gaps in the tone, {sum(n for _, n in gaps) * 2} ms in all"



def wait_daemon(pid, timeout):
    """Wait for a process that is not our child to exit: its exit code, None
    if it exited but isn't ours to reap, False if it is still running. In
    Docker the suite is PID 1, so a daemon that fppd detached is reparented
    to it and has to be reaped here, or it lingers as a zombie."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                return os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            try:
                with open(f"/proc/{pid}/status") as f:
                    if "\nState:\tZ" in f.read():
                        return None
            except FileNotFoundError:
                return None
        time.sleep(0.2)
    return False


class Daemonized:
    """fppd started as "fppd -d -v 30", the way an init script would, with
    a stand-in pactl on PATH recording the volumes fppd applies. The
    command that launches it records the launching process's exit code and
    then stays up, so the fixture has something to watch; the daemon itself
    is found by hand and stopped by stop()."""

    def __init__(self, fppd, slow_amixer=False):
        args = ["-d", "-v", "30"]
        self.fppd = fppd
        self.binary = os.path.realpath(os.path.join(fppd.tree, "src", "fppd"))
        shim = os.path.join(fppd.media, "tmp", "shim")
        self.shim = shim
        self.calls = os.path.join(shim, "pactl.log")
        self.rc_file = os.path.join(fppd.media, "tmp", "launcher.rc")
        os.makedirs(shim)
        with open(os.path.join(shim, "pactl"), "w") as f:
            f.write(f'#!/bin/sh\necho "$*" >> "{self.calls}"\n')
        os.chmod(os.path.join(shim, "pactl"), 0o755)
        if slow_amixer:
            # A card's mixer controls are listed with amixer, under a lock;
            # on a device that takes a moment, and "-v" makes it happen
            # just as fppd forks.
            with open(os.path.join(shim, "amixer"), "w") as f:
                f.write("#!/bin/sh\nsleep 2\n")
            os.chmod(os.path.join(shim, "amixer"), 0o755)
            # And give the worker time to get there before the fork:
            # "-v" is handled as it is parsed, and each later "-m player"
            # (the default mode) is a moment more before fppd forks.
            args += ["-m", "player"] * 20000
        fppd.start(argv=["sh", "-c", 'rc="$1"; shift; "$0" "$@"; echo $? > "$rc"; exec sleep 3600',
                         self.binary, self.rc_file, *args],
                   extra_env={"PATH": shim + ":" + os.environ["PATH"]})
        fppd.exit_expected = True
        try:
            fppd.wait_for(lambda: len(self.daemons()) == 1, timeout=10, what="a single fppd daemon")
        except BaseException:
            # Left running, a daemon keeps the API and DDP ports, and every
            # later scenario in the run fails on them or talks to it.
            self.kill_daemons()
            raise
        self.pid = self.daemons()[0]

    def daemons(self):
        """The fppd processes this launch forked away. Told from any other
        fppd -- under run-local.sh, the device's own, which is the same
        binary with no launcher for a parent -- by the shim directory on the
        PATH this launch gave it, which a forked daemon inherits."""
        marker = ("PATH=" + self.shim + ":").encode()
        pids = []
        for p in os.listdir("/proc"):
            if p.isdigit():
                try:
                    with open(f"/proc/{p}/status") as f:
                        ppid = int(f.read().split("PPid:")[1].split()[0])
                    if os.path.realpath(f"/proc/{p}/exe") != self.binary or ppid == self.fppd.proc.pid:
                        continue
                    with open(f"/proc/{p}/environ", "rb") as f:
                        if any(e.startswith(marker) for e in f.read().split(b"\0")):
                            pids.append(int(p))
                except (OSError, IndexError, ValueError):
                    pass
        return pids

    def kill_daemons(self):
        import signal
        for pid in self.daemons():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    def volumes_set(self):
        try:
            with open(self.calls) as f:
                return [l.split()[-1] for l in f if l.startswith("set-sink-volume")]
        except FileNotFoundError:
            return []

    def launcher_rc(self):
        """The launching process's exit code, or None while it runs."""
        try:
            with open(self.rc_file) as f:
                return int(f.read())
        except (FileNotFoundError, ValueError):
            return None

    def stop(self):
        import signal
        import subprocess
        os.kill(self.pid, signal.SIGTERM)
        rc = wait_daemon(self.pid, 30)
        if rc is False:
            with open(os.path.join(self.fppd.media, "logs", "daemon-backtrace.txt"), "w") as f:
                subprocess.run(["gdb", "-p", str(self.pid), "-batch", "-nx", "-ex", "thread apply all bt"],
                               stdout=f, stderr=subprocess.STDOUT, timeout=120)
            os.kill(self.pid, signal.SIGKILL)
            raise AssertionError("the fppd daemon did not exit within 30 s of SIGTERM")
        assert rc in (0, None), f"the fppd daemon exited {rc}"
        reports = self.fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def test_daemonized_fppd_applies_volume_changes(fppd):
    """fppd started in the background with a volume on its command line
    ("fppd -d -v 30", as an init script would) still applies later volume
    changes: it sets the output sink's volume with pactl, which a stand-in
    on PATH records.

    Regression: ec42d3f1e. "-v" is applied while the arguments are parsed,
    which starts the volume worker thread -- before fppd forks into the
    background. The daemon inherited the worker's state but not its thread,
    so every later change was recorded (and read back by the API) but never
    applied.

    Regression: b72e55376. ec42d3f1e started a new worker in the daemon, but
    the original's worker could be mid-change when fppd forked, holding the
    lock around the card's mixer control list (its amixer calls), and the
    daemon inherited that lock held by a thread it doesn't have: its
    worker blocked on it at the first change, for good. A slow amixer
    stand-in holds that lock for 2 s, and padding the command line after
    "-v" lets the worker take it before fppd forks, every time. Since
    b72e55376 "-v" only records the level, applied once fppd is the
    daemon."""
    import subprocess
    d = Daemonized(fppd, slow_amixer=True)
    try:
        for level in (50, 40, 60):
            fppd.post(f"/fppd/volume/{level}")
            assert fppd.get("/fppd/volume")["volume"] == level
            try:
                fppd.wait_for(lambda: f"{level}%" in d.volumes_set(), timeout=10,
                              what=f"the daemon to set the sink to {level}% (it set {d.volumes_set()})")
            except TimeoutError:
                with open(os.path.join(fppd.media, "logs", "daemon-backtrace.txt"), "w") as f:
                    subprocess.run(["gdb", "-p", str(d.pid), "-batch", "-nx", "-ex", "thread apply all bt"],
                                   stdout=f, stderr=subprocess.STDOUT, timeout=120)
                raise
    finally:
        d.stop()


def test_fppd_d_returns_to_its_caller(fppd):
    """"fppd -d -v 30" returns 0 to whatever ran it once the daemon is
    detached, as an init script or a Type=forking unit expects.

    Regression: da854059f. CreateDaemon() left each parent of its two forks
    with exit(), which ran the static destructors; one of them destroys the
    condition variable the volume worker ("-v" starts it before the fork)
    waits on, and glibc's pthread_cond_destroy() waits for its waiters, so
    the launching process never exited."""
    import subprocess
    d = Daemonized(fppd)
    try:
        try:
            fppd.wait_for(lambda: d.launcher_rc() is not None, timeout=10,
                          what="the process that ran \"fppd -d\" to exit")
        except TimeoutError:
            launcher = [p for p in os.listdir("/proc") if p.isdigit() and p != str(d.pid)
                        and os.path.realpath(f"/proc/{p}/exe") == d.binary]
            with open(os.path.join(fppd.media, "logs", "launcher-backtrace.txt"), "w") as f:
                for p in launcher:
                    subprocess.run(["gdb", "-p", p, "-batch", "-nx", "-ex", "thread apply all bt"],
                                   stdout=f, stderr=subprocess.STDOUT, timeout=120)
            raise
        assert d.launcher_rc() == 0, f"\"fppd -d\" exited {d.launcher_rc()}"
    finally:
        d.stop()


def test_lights_follow_the_media_position(fppd, audio):
    """Each frame goes on the wire close to when the media position reaches
    it: within 15 ms of it (median), with a 10-90% spread of 15 ms at most on
    a real card, 20 ms against the null sink.

    Media sync only acted on whole-frame differences, once a second, so the
    frames wandered around the position. A phase servo now closes the timing
    error itself (f2d25dc05). Pi 5 I2S, three songs: 10-90% spread 18-22 ms
    and medians -6..12 ms on the parent; 9-11 ms and -6..-4 ms on the fix.

    Only a real card (run-local.sh --host-audio) tells the fix from its
    parent: against the null sink in Docker the parent also stays within
    12-13 ms. There the test only guards against gross breakage, and the
    spread limit has headroom: under ASan the fix measures 11-14 ms alone and
    15-16 ms with other scenarios running in the same VM.

    Needs no sound reference: fppd's own status reports the media position
    the lights follow (to 10 ms, truncated), so this runs against a null
    sink as well as a real card. Whether that position is right for the
    sound is the other tests' business.
    """
    secs, songs = 12, 3
    entries, lookups = [], []
    for n in range(songs):
        frames = unique_frames(secs * 20, CHANNELS, first=20000 * n)
        lookups.append({f: i for i, f in enumerate(frames)})
        write_fseq(os.path.join(fppd.media, "sequences", f"P{n}.fseq"), frames)
        write_tone_wav(os.path.join(fppd.media, "music", f"P{n}.wav"), secs, amplitude=0.1,
                       bursts=[(1, 0.1)])
        entries.append({"type": "both", "enabled": 1, "playOnce": 0,
                        "sequenceName": f"P{n}.fseq", "mediaName": f"P{n}.wav"})
    fppd.write("playlists/Pos.json", playlist("Pos", entries))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    polls = []
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Pos", "false", "false")
        end = time.monotonic() + songs * secs + 5
        while time.monotonic() < end:
            t0 = time.monotonic()
            s = fppd.get("/fppd/status")
            t1 = time.monotonic()
            seq, ms = s.get("current_sequence", ""), s.get("milliseconds_elapsed")
            if seq.startswith("P") and isinstance(ms, int):
                polls.append(((t0 + t1) / 2, int(seq[1:].split(".")[0]), ms))
            time.sleep(0.2)
        received = rx.snapshot()
    first_seen = [{} for _ in range(songs)]
    for t, d in received:
        for n in range(songs):
            i = lookups[n].get(d[:CHANNELS])
            if i is not None:
                first_seen[n].setdefault(i, t)
    errs = [[] for _ in range(songs)]
    for t, n, ms in polls:
        if not 2000 <= ms <= (secs - 1) * 1000:
            continue
        pos = ms + 5  # the report is truncated to 10 ms
        k = int(pos // 50) + 1  # the next frame due
        seen = first_seen[n].get(k)
        if seen is not None:
            errs[n].append((seen - (t + (k * 50 - pos) / 1000)) * 1000)
    medians = [round(statistics.median(e)) if e else None for e in errs]
    spreads = [round(statistics.quantiles(e, n=10)[-1] - statistics.quantiles(e, n=10)[0]) if len(e) > 10 else None
               for e in errs]
    print(f"frame on the wire minus when the media position put it, per song: median {medians} ms, "
          f"10-90% spread {spreads} ms")
    assert None not in medians, f"a song was not seen on the wire or in the status: {medians}"
    assert all(abs(m) <= 15 for m in medians), \
        f"the lights sit {medians} ms from where the media position puts them"
    limit = 15 if os.environ.get("FPP_TESTS_HOST_AUDIO") else 20
    assert None not in spreads and all(sp <= limit for sp in spreads), \
        f"the lights wander {spreads} ms (10-90%) around where the media position puts them"


def write_wav_at(path, seconds, rate, freq=1000, amplitude=0.5):
    """A mono 16-bit tone at `rate` Hz (write_tone_wav is 48 kHz only)."""
    import array
    import math
    import wave
    n = int(seconds * rate)
    pcm = array.array("h", (int(amplitude * 32767 * math.sin(2 * math.pi * freq * i / rate))
                            for i in range(n)))
    if array.array("h", [1]).tobytes() != b"\x01\x00":
        pcm.byteswap()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return path


def test_play_media_answers_while_pipewire_is_frozen(fppd, audio):
    """With the PipeWire daemon up but not answering (stopped), Play Media
    of a 96 kHz file still answers within seconds, and once PipeWire runs
    again media plays.

    Regression: ede0b7eaf. Above 48 kHz Start() asks PipeWire for the
    graph rate with pw-metadata, which had no timeout, and Start() runs
    under mediaOutputLock: the command never answered, and nothing else
    could start media. (The rate is cached, so this has to be the run's
    first media.)"""
    if os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("stops the scenario's own PipeWire; under --host-audio that is the device's")
    import signal
    write_wav_at(os.path.join(fppd.media, "music", "Hi.wav"), 2, 96000)
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 2)
    fppd.start()
    daemon = audio.procs[0]
    os.kill(daemon.pid, signal.SIGSTOP)
    try:
        started = time.monotonic()
        try:
            fppd.command("Play Media", "Hi.wav", "1", "0", "1", timeout=20)
        except urllib.error.HTTPError:
            pass  # refused is fine; not answering is the bug
        took = time.monotonic() - started
    finally:
        os.kill(daemon.pid, signal.SIGCONT)
    assert took < 10, f"Play Media took {took:.1f} s to answer with PipeWire stopped"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                  what="the first media to end")
    rec = audio.record()
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    time.sleep(3)
    samples = rec.stop()
    first, last = sounding(samples)
    assert first is not None and last - first > 1.5, "nothing played once PipeWire ran again"


def test_missing_audio_card_warning_comes_down(fppd):
    """A configured audio output card that isn't present raises a warning,
    and the warning comes down once the setting no longer names it.

    Regression: 680451806. The warning names the card, but it was removed
    with the text "Audio output card is not present", which RemoveWarning()
    never matched: the banner stayed until fppd restarted."""
    from test_command_socket import send
    fppd.settings(AudioOutput="FakeCard")
    fppd.start()

    def warned():
        return any("Audio output card 'FakeCard'" in w
                   for w in fppd.get("/fppd/status").get("warnings", []))
    fppd.wait_for(warned, timeout=45, interval=1, what="the missing-card warning")
    send("SetSetting,AudioOutput,,")
    fppd.wait_for(lambda: not warned(), timeout=15, interval=1,
                  what="the missing-card warning to come down")


def test_a_wedged_audio_teardown_does_not_restart_fppd(fppd, audio):
    """A pipeline with no hardware video decoder whose teardown wedges (a
    shim holds its NULL transition past fppd's 10 s deadline) is abandoned
    and logged, and does not count toward the wedge restart: fppd keeps
    running, with the restart limit at 1.

    Regression: 84e1122ae. Every abandoned teardown counted toward
    restarting fppd (and then rebooting), a ladder that exists only for a
    wedged hardware decoder: an audio track on a BeagleBone walked a show
    controller up to a restart. (The reboot rung is off here, so a device
    run of the parent can't reboot the box.)"""
    import shims
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 1)
    fppd.settings(GStreamerWedgeRestartLimit="1", GStreamerWedgeRebootLimit="0")
    fppd.start(preload=[shims.build("slownull.c")])
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    fppd.wait_for(lambda: "teardown wedged" in fppd.log() or "restarting fppd" in fppd.log(),
                  timeout=30, interval=0.5, what="the teardown to be abandoned")
    time.sleep(3)
    log = fppd.log()
    assert "restarting fppd" not in log, "an audio-only teardown wedge restarted fppd"
    assert "not counted toward a restart" in log
    fppd.get("/fppd/status", timeout=10)


def test_volume_answers_while_pactl_is_slow(fppd):
    """With pactl slow to answer (a stand-in that takes 5 s, as a wedged
    PipeWire makes it), a volume change still answers at once and reads
    back the new level.

    Regression: cbf88ae78. setVolume() ran pactl, once per output sink, on
    the thread that asked -- an HTTP thread here, the main loop for the UI
    slider's command -- so the request waited out every call."""
    bindir = os.path.join(fppd.media, "tmp", "bin")
    os.makedirs(bindir)
    with open(os.path.join(bindir, "pactl"), "w") as f:
        f.write("#!/bin/sh\nsleep 5\n")
    os.chmod(os.path.join(bindir, "pactl"), 0o755)
    fppd.settings(MediaBackend="pipewire-simple", volume="70")
    fppd.start(extra_env={"PATH": bindir + ":" + os.environ["PATH"]})
    started = time.monotonic()
    fppd.post("/fppd/volume/50", timeout=3)
    took = time.monotonic() - started
    assert took < 2, f"the volume change took {took:.1f} s to answer"
    assert fppd.get("/fppd/volume", timeout=3)["volume"] == 50
