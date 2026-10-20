"""Video decoded in hardware (a Pi 4's V4L2 H.264 decoder) into a pixel
overlay model.

A hardware decoder hands out its frames as mmapped device buffers, sized
exactly to the picture, where a software decoder's sit in heap memory with
slack after them. Docker decodes in software, so this runs only where
there is a V4L2 H.264 decoder (run-local.sh on a Pi 4; a Pi 5 has none).

Whether the page after a device buffer is mapped is up to the kernel, so a
read past the end of a frame faults only on some runs (1 in 6 for a stock
GStreamer pipeline on a Pi 4). A shim (v4l2guard.c) puts an inaccessible
page after every buffer fppd maps from the device, so it faults every time.
"""

import glob
import os
import shutil
import subprocess

import pytest

from show import ddp_output, status
from test_video import MODEL, W, H, model


def hw_h264_decoder():
    if not shutil.which("gst-inspect-1.0"):
        return False
    r = subprocess.run(["gst-inspect-1.0", "v4l2h264dec"], capture_output=True, text=True)
    return r.returncode == 0 and glob.glob("/dev/video1[0-9]")


def make_h264(path, width, height, seconds=4, fps=10):
    r = subprocess.run(
        ["gst-launch-1.0", "-q", "videotestsrc", f"num-buffers={seconds * fps}", "pattern=smpte", "!",
         f"video/x-raw,format=I420,width={width},height={height},framerate={fps}/1", "!",
         "x264enc", "speed-preset=ultrafast", "!", "video/x-h264,profile=baseline", "!",
         "h264parse", "!", "mp4mux", "!", "filesink", f"location={path}"],
        capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make an H.264 video (x264enc): {r.stderr.strip()[-300:]}")


def holds_decoder(pid):
    """Whether the process has a V4L2 decoder device (/dev/video1x) open."""
    for fd in glob.glob(f"/proc/{pid}/fd/*"):
        try:
            if os.readlink(fd).startswith("/dev/video1"):
                return True
        except OSError:
            pass
    return False


@pytest.mark.skipif(not hw_h264_decoder(), reason="needs a V4L2 H.264 decoder (Pi 4)")
def test_a_hardware_decoded_video_reaches_an_overlay_model(fppd, audio):
    """Play Media of a 1280x384 H.264 file straight to a pixel overlay
    model, decoded by the Pi 4's hardware decoder: the model shows the
    picture, and fppd plays it to the end.

    Regression: 998ed3e3b. videoconvert's I420 kernels, as ORC 0.4.41
    compiles them for arm64, read 2 bytes past the end of the frame. A
    1280x384 picture needs no alignment padding, so the decoder's buffer
    ends on a page boundary and the over-read faulted: fppd died (SIGSEGV
    in video_orc_convert_I420_ARGB) on the first frame of every play. With
    the guard page, on every run here; ORC_CODE=backup reads it cleanly."""
    make_h264(os.path.join(fppd.media, "videos", "Wide.mp4"), 1280, 384)
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.settings(DisableFakeNetworkBridges="1")
    import shims
    guard_log = os.path.join(fppd.media, "tmp", "v4l2guard.log")
    fppd.start(preload=[shims.build("v4l2guard.c")], extra_env={"V4L2GUARD_LOG": guard_log})
    fppd.command("Play Media", "Wide.mp4", "1", "0", "1", MODEL)
    decoded = []

    def lit():
        decoded.append(holds_decoder(fppd.proc.pid))
        data = fppd.get(f"/overlays/model/{MODEL}/data").get("data") or []
        return sum(1 for v in data if v > 32) > W * H // 4
    fppd.wait_for(lit, timeout=15, interval=0.1, what="the model to show the video")
    assert any(decoded), "precondition: fppd never opened the hardware decoder, so this decoded in software"
    with open(guard_log) as f:
        sizes = {int(l) for l in f if l.strip()}
    assert 1280 * 384 * 3 // 2 in sizes, \
        f"precondition: no decoded frame was mapped from the device behind a guard page: {sizes}"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.2,
                  what="the video to end")
