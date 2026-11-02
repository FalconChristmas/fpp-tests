"""H.265 video on a Pi, whose stateless V4L2 decoder can abort fppd."""

import os
import shutil
import subprocess
import tempfile

import pytest

from show import ddp_output, status
from test_video import MODEL, W, H, model


def _fake_decoder():
    """The directory holding a plugin that stands in for v4l2slh265dec (fakehevcdec.c)."""
    if not shutil.which("gcc"):
        pytest.skip("gcc is needed to build the stand-in decoder")
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0"],
                           capture_output=True, text=True).stdout.split()
    src = os.path.join(os.path.dirname(__file__), "fakehevcdec.c")
    d = tempfile.mkdtemp(prefix="fakehevc-")
    r = subprocess.run(["gcc", "-shared", "-fPIC", "-o", os.path.join(d, "libgstfakehevcdec.so"), src, *flags],
                       capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"cannot build the stand-in decoder: {r.stderr.strip()[-200:]}")
    return d


def _make_hevc(path):
    """3 s of 1080p30 H.265 with an AAC track: ffmpeg's if there is one, else
    gst-launch's (x265)."""
    if shutil.which("ffmpeg"):
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30",
               "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3",
               "-c:v", "libx265", "-preset", "ultrafast", "-g", "75", "-pix_fmt", "yuv420p",
               "-tag:v", "hvc1", "-x265-params", "log-level=error", "-c:a", "aac", "-ac", "2", path]
    else:
        cmd = ["gst-launch-1.0", "-q", "qtmux", "name=mux", "!", "filesink", f"location={path}",
               "videotestsrc", "num-buffers=90", "!", "video/x-raw,width=1920,height=1080,framerate=30/1",
               "!", "x265enc", "speed-preset=ultrafast", "!", "h265parse", "!", "mux.",
               "audiotestsrc", "volume=0.1", "samplesperbuffer=4410", "num-buffers=30", "!",
               "audio/x-raw,rate=44100,channels=2", "!", "audioconvert", "!", "voaacenc", "!",
               "aacparse", "!", "mux."]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode:
        pytest.skip(f"cannot make the test video: {r.stderr.strip()[-200:]}")


def test_a_1080p_h265_video_is_decoded_in_software(fppd, audio):
    """Play Media of a 1080p30 H.265 video on a Pi, whose stateless V4L2
    decoder is installed, plays it with the software decoder.

    Regression: e9f6b6be1.  GStreamer 1.26.2
    dereferences a NULL request in v4l2slh265dec when the driver refuses a
    stream's bitstream parameters, which aborted fppd -- on a remote joining
    mid-song, on every restart.  Fixed upstream in 1.26.10; Pi OS ships
    1.26.2.

    Runs against fakehevcdec.c, a stand-in decoder of that name that outranks
    the software one and, if it is ever fed, leaves a marker and fails the
    stream: the image has no V4L2 decoders.  Needs gcc, and ffmpeg or x265enc
    to make the file."""
    path = os.path.join(fppd.media, "videos", "Hevc.mp4")
    _make_hevc(path)
    plugins = _fake_decoder()
    used = os.path.join(plugins, "used")
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=MODEL)
    fppd.start(extra_env={"GST_PLUGIN_PATH": plugins, "GST_REGISTRY_1_0": os.path.join(plugins, "registry.bin"),
                          "FAKEHEVC_FILE": used})
    fppd.command("Play Media", "Hevc.mp4", "1", "0", "1", "--Default--")
    fppd.wait_for(lambda: "in software, not with v4l2slh265dec" in fppd.log(), timeout=15,
                  what="the 1080p H.265 file to be sent to the software decoder")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=40, interval=0.5,
                  what="the video to play to its end")
    assert not os.path.exists(used), "the stateless decoder was fed the stream"
    assert "sync error" not in fppd.log(), "the pipeline reported an error"
