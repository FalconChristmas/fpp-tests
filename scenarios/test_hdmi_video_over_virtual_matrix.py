"""A video on an HDMI port with a Virtual Matrix on it, on a Pi 0-3.

Hardware-only: needs a Raspberry Pi 0-3 on full KMS (vc4, "brcm,bcm2835-vc4")
with a display on HDMI-A-1 running 1920x1080 @ 60Hz, and the card's DRM
master free -- stop the device's own fppd for the run if it drives a display
(`sudo systemctl stop fppd`). The video plays on the real display. Verified
with run-local.sh on a Pi 3 Model B: fails at c7a2fca, passes at 27872fa1c.

The vc4 kernel driver on a Pi 0-3 adds up what every enabled plane costs the
display controller (HVS) and refuses a plane commit over 240M cycles/s, with
ENOSPC and nothing in dmesg. A 288x168 Virtual Matrix at 6x is a 1728x1008
plane scaled to 1920x1080: 62.2M. A full-screen 1080p I420 video plane:
186.6M. Together they are over the limit.
"""

import fcntl
import glob
import os
import subprocess
import time

import pytest

CONNECTOR = "HDMI-A-1"
VIDEO = "Full1080.mp4"
ENOSPC = "No space left on device"

DRM_IOCTL_SET_MASTER = 0x641E
DRM_IOCTL_DROP_MASTER = 0x641F


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read().replace(b"\0", b" ").decode(errors="replace").strip()
    except OSError:
        return ""


def why_not():
    """Why this device can't run the scenario, or None."""
    if "brcm,bcm2835-vc4" not in read("/proc/device-tree/soc/gpu/compatible"):
        return "not a Raspberry Pi 0-3 on full KMS (the load limit is only enforced there)"
    status = glob.glob(f"/sys/class/drm/card*-{CONNECTOR}/status")
    if not status or read(status[0]) != "connected":
        return f"nothing connected on {CONNECTOR}"
    card = "/dev/dri/" + os.path.basename(os.path.dirname(status[0])).split("-")[0]
    if "1920x1080" not in read(os.path.join(os.path.dirname(status[0]), "modes")).split():
        return f"the display on {CONNECTOR} has no 1920x1080 mode"
    # The test fppd has to become DRM master to drive the display.
    try:
        fd = os.open(card, os.O_RDWR)
    except OSError as e:
        return f"cannot open {card}: {e}"
    try:
        fcntl.ioctl(fd, DRM_IOCTL_SET_MASTER)
        fcntl.ioctl(fd, DRM_IOCTL_DROP_MASTER)
    except OSError:
        return f"another process is DRM master on {card} (stop the device's fppd for the run)"
    finally:
        os.close(fd)
    return None


REASON = why_not()
pytestmark = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def make_video(path, seconds=10):
    """Full-frame 1920x1080 H.264, no audio, no letterbox bars: decoded on
    the Pi's hardware decoder to an I420 plane covering the whole screen."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                        "-i", f"testsrc2=size=1920x1080:rate=24:duration={seconds}",
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                        "-profile:v", "high", path],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make a 1080p H.264 video (ffmpeg): {r.stderr.strip()[-300:]}")


def setup(fppd):
    """The configuration from the report: a 288x168 Virtual Matrix on the
    HDMI port, scaled in hardware to the display."""
    w, h = 288, 168
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "VirtualMatrix", "description": "ProjectionMatrix",
        "device": CONNECTOR, "width": w, "height": h, "layout": f"{w}x{h}",
        "scaling": "Hardware", "colorOrder": "RGB", "invert": 0, "xoff": 0, "yoff": 0,
        "startChannel": 1, "channelCount": w * h * 3}]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info", LogLevel_MediaOut="debug")
    make_video(os.path.join(fppd.media, "videos", VIDEO))


def mode_line(fppd):
    return next((line for line in fppd.log().splitlines()
                 if f"KMSFrameBuffer: {CONNECTOR} mode" in line), "")


def count(fppd, text):
    return fppd.log().count(text)


def test_a_1080p_video_plays_over_a_virtual_matrix_on_its_port(fppd, audio):
    """A full-screen 1080p video plays to HDMI with a Virtual Matrix on the
    same port, and the matrix is back once the video is over. Twice, so a
    video that takes the port after another gave it back is covered too.

    Regression: 27872fa1c. The matrix stood aside by putting black on its
    plane, which still counted against the display load, and only on its
    own next flip -- never, with nothing sending it channel data. Its plane
    and the video's were over the limit, kmssink's first frame failed with
    "drmModeSetPlane failed: No space left on device (28)", and the video
    never started.
    """
    setup(fppd)
    fppd.start()
    fppd.wait_for(lambda: mode_line(fppd), timeout=15, what=f"the Virtual Matrix to light {CONNECTOR}")
    if "1920x1080 @ 60Hz" not in mode_line(fppd):
        pytest.skip(f"the display runs {mode_line(fppd).split('mode', 1)[-1].strip()}; "
                    "the load is only over the limit at 1920x1080 @ 60Hz")

    for run in (1, 2):
        aside = count(fppd, "media is playing here, standing aside")
        back = count(fppd, "media finished, showing output again")
        fppd.command("Play Media", VIDEO, "1", "0", "1", CONNECTOR)
        # Past the first frame: before the fix the pipeline gave up within
        # a few hundred milliseconds of it.
        time.sleep(4)
        st = fppd.get("/fppd/status")
        assert ENOSPC not in fppd.log(), \
            f"run {run}: the display refused the video's plane\n{fppd.tail()}"
        assert st.get("status_name") != "idle", \
            f"run {run}: the video is not playing 4s in (status {st.get('status_name')!r})\n{fppd.tail()}"
        assert count(fppd, "media is playing here, standing aside") > aside, \
            f"run {run}: the Virtual Matrix did not stand aside for the video\n{fppd.tail()}"

        fppd.command("Stop Now")
        fppd.wait_for(lambda: count(fppd, "media finished, showing output again") > back, timeout=10,
                      what=f"run {run}: the Virtual Matrix to come back after the video")
