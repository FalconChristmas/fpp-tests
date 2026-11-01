"""H.265 video on a Pi, whose stateless V4L2 decoder can abort fppd."""

import os
import shutil
import subprocess

import pytest

from show import ddp_output, status
from test_video import MODEL, W, H, model


def _has_decoder():
    if not shutil.which("gst-inspect-1.0"):
        return False
    return subprocess.run(["gst-inspect-1.0", "v4l2slh265dec"], capture_output=True).returncode == 0


def test_a_1080p_h265_video_is_decoded_in_software(fppd, audio):
    """Play Media of a 1080p30 H.265 video on a Pi, whose stateless V4L2
    decoder is installed, plays it with the software decoder.

    Regression: 7873db978.  GStreamer 1.26.2
    dereferences a NULL request in v4l2slh265dec when the driver refuses a
    stream's bitstream parameters, which aborted fppd -- on a remote joining
    mid-song, on every restart.  Fixed upstream in 1.26.10; Pi OS ships
    1.26.2.

    Device only: needs the decoder, and ffmpeg to make the file."""
    if not _has_decoder() or not shutil.which("ffmpeg"):
        pytest.skip("needs a Pi with v4l2slh265dec, and ffmpeg")
    path = os.path.join(fppd.media, "videos", "Hevc.mp4")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
                        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "12",
                        "-c:v", "libx265", "-preset", "ultrafast", "-g", "75", "-pix_fmt", "yuv420p",
                        "-tag:v", "hvc1", "-x265-params", "log-level=error", "-c:a", "aac", "-ac", "2", path],
                       capture_output=True, text=True, timeout=180)
    if r.returncode:
        pytest.skip(f"cannot make the test video: {r.stderr.strip()[-200:]}")
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=MODEL)
    fppd.start()
    fppd.command("Play Media", "Hevc.mp4", "1", "0", "1", "--Default--")
    fppd.wait_for(lambda: "in software, not with v4l2slh265dec" in fppd.log(), timeout=15,
                  what="the 1080p H.265 file to be sent to the software decoder")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=40, interval=0.5,
                  what="the video to play to its end")
    assert "sync error" not in fppd.log(), "the pipeline reported an error"
