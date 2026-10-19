"""Sequence playback, checked on the wire.

The sequence is written by FPP's own FSEQ writer and every frame is unique,
so what a DDP receiver on this machine gets can be matched frame by frame
against the file: drops, repeats, reordering and corruption all show up
without any timing assumptions (frames.analyze).
"""

import os
import time

import pytest

from ddp import DdpReceiver
from fppd import sanitizer
from frames import analyze
from fseq import solid_frames, unique_frames, write_fseq_reference
from show import CHANNELS, install, status

STEP_MS = 50


def start(fppd, name="Show"):
    fppd.command("Start Playlist", name, "false", "false")


def wait_idle(fppd, timeout):
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=timeout,
                  interval=0.25, what="the playlist to finish")


def assert_faithful(frames, received, allowed_drops=0.02):
    """Every frame of the file arrived, in order, intact. A few drops or
    repeats are tolerated (a loaded sanitizer build on a shared CI runner);
    corruption and reordering are not."""
    r = analyze(frames, received)
    summary = r.summary()
    assert r.unknown == 0, f"frames on the wire that are in no source frame: {summary}"
    assert r.backwards == 0, f"frames went backwards: {summary}"
    assert r.first_index == 0, f"playback did not start at frame 0: {summary}"
    assert r.last_index == len(frames) - 1, f"playback did not reach the last frame: {summary}"
    assert r.dropped <= allowed_drops * len(frames), f"too many frames dropped: {summary}"
    assert r.interior_black == 0, f"black frames in the middle of playback: {summary}"
    return r


def test_every_frame_reaches_the_wire_in_order(fppd):
    """A 10 s sequence plays to the end with every frame on the wire, in
    order and intact; then the output goes black and the player goes idle."""
    frames = unique_frames(200, CHANNELS)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.start()
        start(fppd)
        wait_idle(fppd, timeout=25)
        time.sleep(0.5)
        r = assert_faithful(frames, rx.snapshot())
        assert r.cadence_ms and 40 <= r.cadence_ms <= 65, f"frame cadence off: {r.summary()}"
        assert not any(rx.last()), "the output was left showing the last frame instead of black"


def test_status_through_play_pause_resume_stop(fppd):
    """Status and output agree through a playlist's life.

    - playing: status names the playlist and sequence and its elapsed time
      advances;
    - paused: status says so, elapsed time holds, and the output goes black
      and stops (by design: Pause closes the sequence and blanks, so another
      playlist can run in between);
    - resumed: playback continues from the paused frame, nothing skipped or
      replayed;
    - Stop Now: status goes idle and the output goes black.
    """
    frames = unique_frames(400, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.start()
        start(fppd)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing")
        time.sleep(1.5)
        s = status(fppd)
        assert s["current_sequence"] == "Show.fseq", s
        assert s["current_playlist"]["playlist"] == "Show", s
        e1 = s["milliseconds_elapsed"]
        time.sleep(1)
        e2 = status(fppd)["milliseconds_elapsed"]
        assert e2 - e1 >= 700, f"elapsed time barely moved while playing: {e1} -> {e2}"

        fppd.command("Pause Playlist")
        paused_at = time.monotonic()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", what="paused")
        held = status(fppd)["milliseconds_elapsed"]
        time.sleep(1.5)
        s = status(fppd)
        assert s["status_name"] == "paused" and s["milliseconds_elapsed"] == held, \
            f"elapsed time moved while paused: {held} -> {s['milliseconds_elapsed']}"
        assert not any(rx.last()), "pausing did not blank the output"
        before = rx.count()
        time.sleep(1)
        assert rx.count() == before, "frames kept coming while paused"
        last_content = [lookup[d] for t, d in rx.snapshot() if t < paused_at and d in lookup][-1]

        resumed_at = time.monotonic()
        fppd.command("Resume Playlist")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="playing again")
        assert rx.wait_frames(10, since=resumed_at), "no output after resuming"
        after = [lookup[d] for t, d in rx.snapshot(since=resumed_at) if d in lookup]
        assert after, "only black frames after resuming"
        assert last_content - 1 <= after[0] <= last_content + 2, \
            f"resumed at frame {after[0]}, paused after frame {last_content}"

        fppd.command("Stop Now")
        wait_idle(fppd, timeout=10)
        s = status(fppd)
        assert s["current_sequence"] == "" and s["current_playlist"]["playlist"] == "", s
        time.sleep(0.5)
        assert not any(rx.last()), "Stop Now did not blank the output"


VARIANTS = {
    "v2-zstd": dict(version=2, compression="zstd"),
    "v2-zlib": dict(version=2, compression="zlib"),
    "v2-none": dict(version=2),
    "v1": dict(version=1),
    "v2-sparse": dict(version=2, compression="zstd", sparse=[(0, 60), (100, 50)]),
}


@pytest.mark.parametrize("variant", list(VARIANTS))
@pytest.mark.parametrize("writer", ["fpp", "reference"])
def test_fseq_formats_play_faithfully(fppd, variant, writer):
    """Each FSEQ flavor plays every frame intact, whether FPP's own writer
    made the file or an independent one did. Sparse files carry only their
    ranges; the channels between them stay dark."""
    args = dict(VARIANTS[variant])
    if writer == "reference" and args.get("compression") == "zstd":
        pytest.importorskip("zstandard")
    frames = unique_frames(100, CHANNELS)
    expected = frames
    if args.get("sparse"):
        keep = bytearray(CHANNELS)
        for s, n in args["sparse"]:
            keep[s:s + n] = b"\1" * n
        expected = [bytes(b if k else 0 for b, k in zip(f, keep)) for f in frames]
    with DdpReceiver(CHANNELS) as rx:
        if writer == "fpp":
            install(fppd, frames, step_ms=STEP_MS, **args)
        else:
            install(fppd, frames, step_ms=STEP_MS, **{"version": 2})
            write_fseq_reference(f"{fppd.media}/sequences/Show.fseq", frames,
                                 step_ms=STEP_MS, blocks=3, **args)
        fppd.start()
        start(fppd)
        wait_idle(fppd, timeout=20)
        time.sleep(0.3)
        assert_faithful(expected, rx.snapshot())


def test_frames_keep_time_over_a_minute(fppd):
    """Over a minute of playback the lights keep the sequence's step time:
    1199 frames at 50 ms take 59.95 s, within 50 ppm on a device. In a
    container a sanitizer build measured 56-292 ppm with the fix depending on
    the host's load, against 1500-1800 without it, so the bound there is 600.

    Regression: fef65433c.

    The output thread used to sleep LightDelay from whenever each pass woke,
    so every wake-up's lateness was added to every frame: 125 ppm slow on a
    Pi 5, 1500 ppm under ASan in Docker. Against the sound that is 7-90 ms a
    minute, and media sync only acts on whole frames."""
    n = 1200
    frames = unique_frames(n, CHANNELS)
    lookup = {f: i for i, f in enumerate(frames)}
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames, step_ms=STEP_MS)
        fppd.start()
        start(fppd)
        wait_idle(fppd, timeout=n * STEP_MS / 1000 + 30)
        seen = {}
        for t, d in rx.snapshot():
            i = lookup.get(d[:CHANNELS])
            if i is not None:
                seen.setdefault(i, t)
    first, last = min(seen), max(seen)
    per_frame = (seen[last] - seen[first]) / (last - first) * 1000
    ppm = (per_frame / STEP_MS - 1) * 1e6
    print(f"{per_frame:.4f} ms per frame over {last - first} frames: {ppm:+.0f} ppm")
    if sanitizer() == "tsan":
        # ThreadSanitizer symbolizes every race where it happens, suppressed
        # ones included, and the first symbolization stalls that thread for
        # tens of ms. One such stall on the output thread restarts the
        # cadence and costs a frame: 800+ ppm over this minute, with fppd
        # keeping time perfectly once reporting is off. That build is for
        # races; the timing is checked by the others.
        return
    # A sanitizer build in a shared container now and then runs a frame more
    # than a frame late, and the cadence restarts after it; on a device the
    # lights should be within a few ppm of the step time (a Pi 5: 0 ppm).
    bound = 600 if os.path.exists("/etc/fpp/container") else 50
    assert abs(ppm) < bound, f"frames took {per_frame:.4f} ms instead of {STEP_MS}: {ppm:+.0f} ppm"


def test_all_lights_off_while_output_is_disabled_and_a_sequence_plays(fppd):
    """"All Lights Off" with channel output disabled (POST /fppd/outputs
    {"command": "disable"}) while a sequence plays blanks without racing the
    output thread.

    Regression: 12257d973. Disabled output only stops the output thread
    sending; it still prepares every frame. The blank was then sent inline
    from the caller's thread with only inlineOutputLock held, so two threads
    ran PrepareChannelData() and every output's PrepData() on the same
    buffers at once (reported by a TSan build)."""
    install(fppd, solid_frames(400, CHANNELS, 77))
    fppd.start()
    fppd.command("Start Playlist", "Show", "true", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=20,
                  what="the sequence to play")
    fppd.post("/fppd/outputs", {"command": "disable"})
    try:
        for _ in range(100):
            fppd.command("All Lights Off")
    finally:
        fppd.post("/fppd/outputs", {"command": "enable"})
    assert status(fppd).get("status_name") == "playing"
