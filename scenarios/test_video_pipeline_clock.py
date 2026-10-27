"""Which clock a video pipeline runs on, seen from the display: the
picture must not wait on an audio sink whose PipeWire stream isn't
running yet."""

import os
import signal
import time

import fakedrm
from show import status
from test_audio_backends import make_video
from test_video import kms_events


def test_a_videos_picture_does_not_wait_for_its_sound_to_start(fppd, audio):
    """A video whose sound has four channels (so it plays to a
    pipewiresink of its own, not the slot's persistent stream) played to
    a display (the fake card's HDMI-A-1) while WirePlumber is held for
    3 s, so the sink's stream is up but not linked, as on a cold start
    whose graph hasn't run yet: the picture moves on the display from the
    start (at least 15 of the 10 fps video's frames in its first 2.5 s),
    and the video still plays out.

    Regression: 728905575. The pipeline took pipewiresink's clock, which
    stands still until its stream processes a quantum: every frame after
    the prerolled one was in the future, kmssink (sync) waited on it, and
    the display sat on the first frame until the stream ran (here 3.1 s
    in) -- or for good, where it never did. The commit forced the system
    clock on the pipeline; its other half (direct kmssink branches added
    before PLAYING) isn't checked here."""
    make_video(os.path.join(fppd.media, "videos", "Quad.mkv"), seconds=6)
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=fakedrm.CONNECTOR)
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    wireplumber = audio.procs[1]
    os.kill(wireplumber.pid, signal.SIGSTOP)
    try:
        started = time.monotonic()
        fppd.command("Play Media", "Quad.mkv", "1", "0", "1", fakedrm.CONNECTOR)
        time.sleep(3)
    finally:
        os.kill(wireplumber.pid, signal.SIGCONT)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.2,
                  what="the video to end")
    frames = [t - started for e, n, c, t in kms_events(fppd) if e == "frame" and c == 35]
    assert len(frames) >= 50, f"{len(frames)} of the 6 s video's 60 frames reached connector 35"
    held = [t for t in frames if t < 2.5]
    assert len(held) >= 15, \
        f"{len(held)} frames reached the display in the first 2.5 s (10 fps); they came at {[round(t, 2) for t in frames[:12]]} s"
