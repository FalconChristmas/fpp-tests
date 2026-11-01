"""A MultiSync remote playing a video it cannot keep up with the master on.

An accurate seek in a video decodes from the previous keyframe, so what one
takes depends on where its target falls; with the keyframes far apart a seek
lands seconds from where it aimed and the next sync asks for another.
"""

import os
import re
import shutil
import socket
import subprocess
import time

import pytest

from multisync import PORT, sync_packet
from show import ddp_output
from test_video import MODEL, W, H, model

SEEK = re.compile(r"GStreamer feed sync: [+-]?\d+ ms from the master .*seeking to")


def test_a_video_remote_that_keeps_missing_stops_seeking(fppd, audio):
    """A remote playing a sparse-keyframe video behind a master whose clock
    runs ahead of it seeks at most three times in 20 s, then says it is
    steering by speed only and seeks no more.

    Regression: 7b33617d5.  AdjustFeedSpeed() sought
    whenever the remote was more than 50 ms off, however many seeks had
    already missed, so a video whose seeks land scattered by seconds
    (FalconChristmas/fpp#3156) seeked every two seconds for the rest of the
    song, and its lead, learnt on those landings, carried into the next.

    Device only: the sparse-keyframe H.264 file comes from ffmpeg, and the
    image has neither it nor an H.264 decoder.  (A Matroska file would not do:
    fppd reads a video's channel count with TagLib, which cannot read one, and
    a video of unknown sound never takes the persistent output stream that
    AdjustFeedSpeed() steers.)"""
    if not shutil.which("ffmpeg"):
        pytest.skip("needs ffmpeg (with libx264) to make a sparse-keyframe video")
    path = os.path.join(fppd.media, "videos", "Sparse.mp4")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "40",
                        "-c:v", "libx264", "-preset", "ultrafast", "-g", "240", "-keyint_min", "240",
                        "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", path],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make the test video: {r.stderr.strip()[-200:]}")
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=MODEL, fppMode="remote",
                  LogLevel_MediaOut="debug")
    fppd.start()
    time.sleep(2)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    send = lambda *a: sock.sendto(sync_packet(*a), ("127.0.0.1", PORT))
    try:
        send("open", "media", 0, 0.0, "Sparse.mp4")
        send("start", "media", 0, 0.0, "Sparse.mp4")
        began = time.monotonic()
        while time.monotonic() - began < 30:
            # the master's clock runs 30% fast: the remote can never catch it
            send("sync", "media", 0, (time.monotonic() - began) * 1.3, "Sparse.mp4")
            time.sleep(0.5)
        log = fppd.log()
    finally:
        send("stop", "media", 0, 0.0, "Sparse.mp4")
        sock.close()
    seeks = SEEK.findall(log)
    assert seeks, "precondition: the remote never made a resync seek"
    assert len(seeks) <= 3, f"{len(seeks)} resync seeks in 30 s"
    assert "steering its speed only" in log
