"""Issue #3083: the sound falls behind the lights after a show has run a
while, survives a playlist restart, and only an fppd restart clears it.

The persistent PipeWire output stream is fed song after song. Anything the
graph failed to take on time -- a stall on an overloaded board, an xrun --
stayed queued inside pipewiresink, invisible to fppd's own estimate of the
queue, and every later song started that far behind its lights.

Real card only (run-local.sh --host-audio): a null sink's VM timer wanders
too far to time this. Hardware-verified on a Pi 5 with an I2S HAT.
"""

import os
import signal
import statistics
import subprocess
import threading
import time

from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist
from audio import write_tone_wav


def _song_offsets(fppd, audio, songs, secs, during=None, settings=None):
    """Play `songs` back-to-back sequence+media songs of `secs` s, each with
    one burst 1 s in; return lights minus audio (ms) at each song's burst.
    `during(t0)` runs on a thread while playing, given the monotonic start.

    Each song's burst is timed by its own short recording, started when the
    song's first frame is seen on the wire: a recording runs through the same
    PipeWire graph, so one that spanned a graph stall would lose samples and
    with them its timing."""
    entries, firsts, bursts = [], [], []
    for n in range(songs):
        frames = unique_frames(secs * 20, CHANNELS, first=20000 * n)
        firsts.append(frames[0])
        bursts.append(frames[20])
        write_fseq(os.path.join(fppd.media, "sequences", f"S{n}.fseq"), frames)
        write_tone_wav(os.path.join(fppd.media, "music", f"S{n}.wav"), secs, amplitude=0.3, bursts=[(1, 0.1)])
        entries.append({"type": "both", "enabled": 1, "playOnce": 0,
                        "sequenceName": f"S{n}.fseq", "mediaName": f"S{n}.wav"})
    fppd.write("playlists/Songs.json", playlist("Songs", entries))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", **(settings or {}))
    offs = []
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Songs", "false", "false")
        t0 = time.monotonic()
        if during:
            threading.Thread(target=during, args=(t0,), daemon=True).start()
        since = t0
        for n in range(songs):
            seen = None
            deadline = time.monotonic() + secs + 15
            while seen is None and time.monotonic() < deadline:
                seen = next((t for t, d in rx.snapshot(since) if d[:CHANNELS] == firsts[n]), None)
                time.sleep(0.02)
            if seen is None:
                offs.append(None)
                continue
            rec = audio.record(rate=8000)
            time.sleep(2.5)
            samples = rec.stop()
            light = next((t for t, d in rx.snapshot(seen) if d[:CHANNELS] == bursts[n]), None)
            thr = 0.05 * max(0.01, max(abs(x) for x in samples))
            hit = next((i for i, x in enumerate(samples) if abs(x) > max(thr, 0.02)), None)
            offs.append(round((light - rec.time_of(hit)) * 1000) if light and hit is not None else None)
            print(f"song {n}: lights minus audio {offs[-1]} ms", flush=True)
            since = seen + secs / 2
    print(f"lights minus audio at each song's burst (ms): {offs}")
    return offs


def _stall_pipewire(at_s, stall_ms):
    """Freeze the host's PipeWire daemon for stall_ms, at_s after t0: the
    graph stops pulling from every stream, as it does on an overloaded
    board, and the card underruns."""
    def run(t0):
        time.sleep(max(0, t0 + at_s - time.monotonic()))
        pid = int(subprocess.run(["pgrep", "-x", "-o", "pipewire"], capture_output=True, text=True).stdout.split()[0])
        os.kill(pid, signal.SIGSTOP)
        time.sleep(stall_ms / 1000)
        os.kill(pid, signal.SIGCONT)
        print(f"stalled pipewire ({pid}) for {stall_ms} ms at {at_s} s")
    return run


def test_graph_stall_does_not_leave_the_sound_behind(fppd, audio):
    """A stall in the PipeWire graph (an overloaded board, an xrun) delays
    the song playing at the time; the songs after it start in sync again.

    Regression: 6f07f92a1 (flush the output stream between tracks).
    Before it, what the feed delivered during the stall stayed queued in
    the persistent output stream and every later song started that much
    behind its lights, until fppd restarted. Pi 5 I2S, 300 ms stall: lights
    minus sound per song [11, 45, -261, -260, -246] ms on the parent,
    [11, 42, 37, 33, 39] on the fix. FPP_TESTS_STALL_MS and
    FPP_TESTS_SONG_SECONDS (default 20) tune it."""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = int(os.environ.get("FPP_TESTS_SONG_SECONDS", "20"))
    stall = int(os.environ.get("FPP_TESTS_STALL_MS", "300"))
    offs = _song_offsets(fppd, audio, 5, secs, during=_stall_pipewire(secs + secs / 2, stall),
                         settings={"PipeWireKeepOutputOpen": "1"})
    assert None not in offs, f"a song's start was not seen on the wire or heard: {offs}"
    before, after = offs[0], offs[2:]
    assert max(abs(o - before) for o in after) <= 50, \
        f"songs after a {stall} ms graph stall start out of step with the first: {offs}"


def test_back_to_back_media_keeps_every_head(fppd, audio):
    """The flush between tracks (6f07f92a1) drops only what was already
    late: each of three back-to-back media-only tones is heard whole, head
    included. The stream drops the first few tens of ms after a flush; fed
    no silence first, each later tone lost 30-60 ms of its head (Pi 5 I2S).
    Passes on the parent too: it guards the fix's own side effect."""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = 3
    entries = []
    for n, f in enumerate((500, 1000, 2000)):
        write_tone_wav(os.path.join(fppd.media, "music", f"T{n}.wav"), secs, freq=f, amplitude=0.3)
        entries.append({"type": "media", "enabled": 1, "playOnce": 0, "mediaName": f"T{n}.wav"})
    fppd.write("playlists/Tones.json", playlist("Tones", entries))
    fppd.settings(PipeWireKeepOutputOpen="1")
    fppd.start()
    time.sleep(2)
    rec = audio.record(rate=48000)
    fppd.command("Start Playlist", "Tones", "false", "false")
    time.sleep(3 * secs + 3)
    samples = rec.stop()
    # Zero crossings per 10 ms window give each window's pitch.
    win = 480
    pitches = []
    for i in range(0, len(samples) - win, win):
        w = samples[i:i + win]
        if max(abs(x) for x in w) < 0.02:
            pitches.append(0)
            continue
        pitches.append(sum(1 for a, b in zip(w, w[1:]) if a < 0 <= b) * 100)
    heard = {f: sum(1 for p in pitches if abs(p - f) <= 0.1 * f) * 10 for f in (500, 1000, 2000)}
    print(f"ms heard of each {secs * 1000} ms tone: {heard}")
    for f, ms in heard.items():
        assert ms >= secs * 1000 - 30, f"the {f} Hz tone lost {secs * 1000 - ms} ms: {heard}"


def test_graph_stall_mid_song_recovers_in_that_song(fppd, audio):
    """A stall in the PipeWire graph partway through a song costs that song
    a skip in its sound, not its sync: a few seconds after the stall the
    sound is back with the lights, in the same song.

    The stall makes the card xrun, and PipeWire restarts it. fppd sees that
    in the card's hardware pointer and flushes its output stream at once,
    dropping what the stall held up. Before that, the between-track flush
    (6f07f92a1) was the first chance, so the rest of the song played behind.

    Regression: 32d77ad7a. Pi 5 I2S, 300 ms stall 15 s in, lights minus sound
    before/after the stall: [2, 2, 30, 70, 80] / [-209 x6] ms on the
    parent, [25, 33, 73, 84, 84] / [23 x6] on the fix. (The audio was 340
    ms late, the lights on time: the sound was held up, not the lights
    pushed ahead; it isn't the card's queue, which held 30-40 ms
    throughout.)"""
    import pytest
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = 40
    stall_at = 15
    stall = int(os.environ.get("FPP_TESTS_STALL_MS", "300"))
    frames = unique_frames(secs * 20, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Long.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Long.wav"), secs, amplitude=0.3,
                   bursts=[(k, 0.1) for k in range(1, secs, 2)])
    fppd.write("playlists/Long.json", playlist("Long", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Long.fseq", "mediaName": "Long.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", PipeWireKeepOutputOpen="1")

    def measure(rx, seen0, window):
        """lights minus audio (ms) for the bursts heard in [start, end) s of
        the song, each window its own recording."""
        start, end = window
        time.sleep(max(0, seen0 + start - 0.7 - time.monotonic()))
        rec = audio.record(rate=8000)
        time.sleep(max(0, seen0 + end - time.monotonic()))
        samples = rec.stop()
        quiet, out = rec.rate, []
        for i, x in enumerate(samples):
            if abs(x) > 0.05 and quiet > rec.rate * 0.5:
                t = rec.time_of(i)
                k = round(t - seen0)  # the burst's second in the song
                light = next((lt for lt, d in rx.snapshot(seen0) if d[:CHANNELS] == frames[k * 20]), None)
                if light and k % 2 == 1:
                    out.append(round((light - t) * 1000))
                    print(f"  burst {k}s: audio {round((t - seen0 - k) * 1000)} ms, lights {round((light - seen0 - k) * 1000)} ms after nominal")
            quiet = 0 if abs(x) > 0.05 else quiet + 1
        return out

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Long", "false", "false")
        seen0 = None
        deadline = time.monotonic() + 15
        while seen0 is None and time.monotonic() < deadline:
            seen0 = next((t for t, d in rx.snapshot() if d[:CHANNELS] == frames[0]), None)
            time.sleep(0.02)
        assert seen0, "the song's first frame never went out"
        before = measure(rx, seen0, (3, 12))
        _stall_pipewire(stall_at, stall)(seen0)
        after = measure(rx, seen0, (25, 36))
    print(f"lights minus audio before the stall {before}, after {after} (ms)")
    assert before and after, f"bursts not heard: before {before}, after {after}"
    shift = statistics.median(after) - statistics.median(before)
    assert abs(shift) <= 50, \
        f"a {stall} ms stall moved the sound {shift:.0f} ms against the lights for the rest of the song"
