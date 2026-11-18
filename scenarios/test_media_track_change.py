"""What is heard, and what the lights do, where one song ends and the next
begins, on a device's real sound card.

Each song's sound is a quiet tone with a loud 40 ms marker at every whole
second, the first right at its first sample, and its sequence has a frame of
its own every 10 ms. One recording of the card's sink, counted in the card's
own samples, spans every song, so between two songs it measures to the
sample how much silence there was and whether all of the earlier song was
heard. And at each marker the lights' frame for that moment is timed off the
wire against the marker in the recording: a song whose lights start in sync
with its sound has the same lights-minus-sound at its first marker as at the
ones after it.

Real card only (run-local.sh --host-audio): a null sink's VM timer wanders
too far to time this. Audible on the device.
"""

import os
import statistics
import time

import pytest

from audio import write_tone_wav
from bursts import card_ppm, card_status
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist

STEP_MS = 10
RATE = 48000


def _song_wav(path, secs):
    """A 1 kHz tone at 0.2 with a 0.7 marker for 40 ms at each whole second."""
    import array
    import math
    total = secs * RATE
    pcm = array.array("h", bytes(2 * total))
    step = 2 * math.pi * 1000 / RATE
    marker = int(0.04 * RATE)
    for i in range(total):
        amp = 0.7 if i % RATE < marker else 0.2
        pcm[i] = int(amp * 32767 * math.sin(step * i))
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())


def _markers(samples, rate):
    """Sample index of each marker's onset: the first sample above the
    marker threshold after at least 0.5 s below it."""
    peak = max(abs(x) for x in samples)
    thr = 0.65 * peak
    out, last = [], -rate
    for i, x in enumerate(samples):
        if abs(x) > thr:
            if i - last > rate // 2:
                out.append(i)
            last = i
    return out, peak


def _quiet_runs(samples, rate, start, end, peak):
    """[(start index, length)] of runs of at least 1 ms with nothing above
    a tenth of the peak, between start and end."""
    win = rate // 1000
    thr = 0.1 * peak
    runs, run_start = [], None
    for w in range(start // win, end // win):
        quiet = max(abs(x) for x in samples[w * win:(w + 1) * win]) < thr
        if quiet and run_start is None:
            run_start = w * win
        elif not quiet and run_start is not None:
            runs.append((run_start, w * win - run_start))
            run_start = None
    if run_start is not None:
        runs.append((run_start, end - run_start))
    return runs


def _play_songs(fppd, audio, songs, secs, settings=None):
    """Play `songs` back-to-back sequence+media songs; return the recording
    (samples, Recording) and, per song, [(marker second, lights time)]."""
    entries, frames_by_song = [], []
    per_song = secs * 1000 // STEP_MS
    for n in range(songs):
        frames = unique_frames(per_song, CHANNELS, first=per_song * n)
        frames_by_song.append(frames)
        write_fseq(os.path.join(fppd.media, "sequences", f"S{n}.fseq"), frames, step_ms=STEP_MS)
        _song_wav(os.path.join(fppd.media, "music", f"S{n}.wav"), secs)
        entries.append({"type": "both", "enabled": 1, "playOnce": 0,
                        "sequenceName": f"S{n}.fseq", "mediaName": f"S{n}.wav"})
    fppd.write("playlists/Songs.json", playlist("Songs", entries))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", **(settings or {}))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        time.sleep(3)
        rec = audio.record(rate=RATE)
        t0 = time.monotonic()
        fppd.command("Start Playlist", "Songs", "false", "false")
        # The card's position through the songs, for its rate: the
        # recording is counted in its samples, which a card hundreds of ppm
        # fast plays that much quicker than the system clock the lights are
        # timed on.
        statuses, until = [], time.monotonic() + songs * secs + 3
        while time.monotonic() < until:
            st = card_status()
            if st:
                statuses.append(st)
            time.sleep(0.25)
        samples = rec.stop()
        seen = {}
        for t, d in rx.snapshot(t0):
            key = bytes(d[:CHANNELS])
            seen.setdefault(key, t)
    lights, last, tails, firsts = [], [], [], []
    for frames in frames_by_song:
        # The song's last frame on the wire, and when its frame 0 first was.
        idx = [i for i, f in enumerate(frames) if bytes(f[:CHANNELS]) in seen]
        tails.append((max(idx), seen[bytes(frames[max(idx)][:CHANNELS])]) if idx else None)
        firsts.append(seen.get(bytes(frames[0][:CHANNELS])))
        # At each whole second, the frame for 10 ms past it: the first frame
        # change of the song. Its frame 0 goes out as the entry is set up and
        # waits there for the sound, so it times nothing.
        lights.append([(s, seen.get(bytes(frames[s * 1000 // STEP_MS + 1][:CHANNELS])))
                       for s in range(secs)])
        last.append(seen.get(bytes(frames[-1][:CHANNELS])))
    return samples, rec, lights, last, tails, firsts, card_ppm(statuses)


def _measure(fppd, audio, songs=4, secs=6, settings=None):
    samples, rec, lights, last, tails, firsts, ppm = _play_songs(fppd, audio, songs, secs, settings)
    def at(i):
        return rec.time_of(i, ppm)
    marks, peak = _markers(samples, RATE)
    assert len(marks) == songs * secs, \
        f"heard {len(marks)} markers, not {songs * secs}: {[round(m / RATE, 3) for m in marks]}"
    report = {"card_ppm": round(ppm, 1), "quiet_ms": [], "heard_ms": [], "start_minus_mid_ms": [], "end_minus_mid_ms": [],
              "frames_unsent_at_end": [], "frame0_early_ms": [], "offsets_ms": []}
    for n in range(songs):
        first = marks[n * secs]
        if n:
            prev_first = marks[(n - 1) * secs]
            runs = _quiet_runs(samples, RATE, marks[n * secs - 1], first, peak)
            quiet = sum(length for _, length in runs)
            report["quiet_ms"].append(round(quiet * 1000 / RATE, 1))
            report["heard_ms"].append(round((first - prev_first - quiet) * 1000 / RATE, 1))
        offs = []
        for s, lt in lights[n]:
            m = marks[n * secs + s]
            offs.append(None if lt is None else round((lt - at(m) - STEP_MS / 1000) * 1000, 1))
        report["offsets_ms"].append(offs)
        mid = [o for o in offs[1:] if o is not None]
        report["start_minus_mid_ms"].append(
            None if offs[0] is None or not mid else round(offs[0] - statistics.median(mid), 1))
        # The song's last frame belongs on the wire when its sound reaches
        # that frame's time: a frame before its end.
        due = at(first) + (secs * 1000 - STEP_MS) / 1000
        per_song = secs * 1000 // STEP_MS
        report["frames_unsent_at_end"].append(None if tails[n] is None else per_song - 1 - tails[n][0])
        report["frame0_early_ms"].append(
            None if firsts[n] is None or not mid else
            round((at(first) - firsts[n]) * 1000 + statistics.median(mid), 1))
        report["end_minus_mid_ms"].append(
            None if last[n] is None or not mid else round((last[n] - due) * 1000 - statistics.median(mid), 1))
    print(f"track changes: {report}", flush=True)
    return report


def _need_card():
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")


def test_back_to_back_songs_are_seamless(fppd, audio):
    """Back-to-back sequence+media songs: no silence between them, all of
    each one heard, and the lights with the sound across every change --
    the last song's to the end of its sound, the next song's from the start
    of its own.

    Fixed by ff545ae5a (the next track carries on the output stream's
    timeline rather than starting on a drained and flushed stream) and
    c52f3cb02 (a song's lights play to the end of its sound; the next
    sequence opens with its sound). Pi 4 headphone jack, four 6 s songs at
    100 fps, on the parent: 116-143 ms of silence between songs, each song's
    last 5-6 frames never sent, and its first frame on the wire 120-200 ms
    before its sound; on the fix 0.0 ms, none unsent, -13..+8 ms.

    And a352000c0 (the next track is left time to carry on at any graph
    rate): on an AM62x PCM5102A cape (graph at 88.2 kHz, the card +433 ppm),
    the bridge laid 2-11 ms of silence at nearly every change on its parent,
    once 105 ms; on the fix 0.0 ms in 13 runs.

    Real card only: verified with run-local.sh --host-audio on a Pi 4, a
    Pi 5 I2S HAT and that cape."""
    _need_card()
    r = _measure(fppd, audio, settings={"PipeWireKeepOutputOpen": "1"})
    assert all(q <= 1.0 for q in r["quiet_ms"]), f"silence between songs (ms): {r['quiet_ms']}"
    assert all(abs(h - 6000) <= 1.0 for h in r["heard_ms"]), \
        f"ms of each 6000 ms song heard: {r['heard_ms']}"
    assert r["frames_unsent_at_end"] == [0] * len(r["frames_unsent_at_end"]), \
        f"frames at the end of each song never sent: {r['frames_unsent_at_end']}"
    assert all(e is not None and abs(e) <= 20 for e in r["end_minus_mid_ms"]), \
        f"each song's last frame against its lights mid-song (ms): {r['end_minus_mid_ms']}"
    assert all(f is not None and abs(f) <= 20 for f in r["frame0_early_ms"]), \
        f"each song's first frame ahead of its sound (ms): {r['frame0_early_ms']}"
    assert all(s is not None and abs(s) <= 25 for s in r["start_minus_mid_ms"]), \
        f"each song's lights at its start against mid-song (ms): {r['start_minus_mid_ms']}"
    # Each song carries on the last one's timeline, so its lights sit where
    # the first song's do.
    mids = [statistics.median([o for o in offs[1:] if o is not None]) for offs in r["offsets_ms"]]
    assert max(mids) - min(mids) <= 15, f"lights minus sound mid-song, per song (ms): {mids}"

