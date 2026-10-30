"""The banner when a display's reported screen shape doesn't match its mode.

FPP issue #3135: an Epson projector's EDID claims a 1600x900 mm (16:9)
screen while it runs its preferred 1280x800 (16:10). kmssink takes that as
non-square pixels and sources the DRM plane from a PAR-scaled 1280x792 for a
1280x720 frame, which the kernel refuses with ENOSPC (GStreamer issue #1555),
so no video ever plays. Forcing a 16:9 resolution (1280x720@60) avoids it.
fppd now says so instead of only "drmModeSetPlane failed: No space left on
device (28)", and a display refusing video has a warning id of its own, 74
(Display Refused Video), apart from 31 (the pipeline couldn't be built).

Runs anywhere, Docker included: the display is the fake Pi 3 card of
fakedrm.c with the projector's EDID size and preferred mode, refusing every
plane commit with ENOSPC (the stand-in kmssink sources the frame's own size,
so it can't trip the real sink's bug by itself). The detection reads the
card the way it would on the Pi; on a Pi 3B+ with the Epson EDID loaded
through drm.edid_firmware the real kmssink fails the same way.
"""

import os
import re

import pytest

import fakedrm
from test_video import make_video

CONNECTOR = fakedrm.CONNECTOR


REFUSED_WARNING_ID = 74   # Display Refused Video


def video_warning(fppd):
    """The video output banner as {"id", "message"}, or None."""
    return next((w for w in fppd.get("/fppd/status").get("warningInfo", [])
                 if w.get("message", "").startswith(f"Video output to {CONNECTOR} failed")), None)


def assert_names_the_fix(w):
    assert w["id"] == REFUSED_WARNING_ID, f"the banner isn't warning {REFUSED_WARNING_ID}: {w!r}"
    assert "screen shape (16:9) doesn't match its 1280x800 resolution" in w["message"], \
        f"the banner doesn't name the mismatch: {w!r}"
    # A Pi or BeagleBone build names its Force HDMI Resolution setting (checked
    # on a Pi 3B+ with the projector's EDID); this one says which mode to run.
    assert "1280x720@60" in w["message"], f"the banner doesn't say which resolution to use: {w!r}"


def play_refused(fppd, **display):
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    video = "Wide720.mkv"
    make_video(os.path.join(fppd.media, "videos", video), seconds=5, width=1280, height=720, fps=10, audio=False)
    preload, env = fakedrm.start_env(fppd, refuse_planes=True, **display)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Play Media", video, "1", "0", "1", CONNECTOR)
    fppd.wait_for(lambda: video_warning(fppd), timeout=20, what="the video output banner")
    return video_warning(fppd)


def test_a_projector_whose_screen_shape_differs_from_its_mode_is_told_which_resolution_to_set(fppd, audio):
    """The Epson's EDID (1600x900 mm, preferring 1280x800): the banner names
    the mismatch and the Force HDMI Resolution value that has the screen's
    shape, one the display offers, at the refresh rate it runs now.

    Fixed by c19d8e5ed (DrmCards::CheckAspectMismatch(),
    VideoOutputManager::AspectMismatchWarning()). Before it the banner was
    "Video output to HDMI-A-1 failed (drmModeSetPlane failed: No space left
    on device (28))", with nothing to say what to change.
    """
    assert_names_the_fix(play_refused(fppd, mm="1600x900", preferred="1280x800"))
    assert "reports a 1600x900 mm screen but runs 1280x800@60" in fppd.log(), \
        "the log doesn't give the EDID size and the mode"


def test_enospc_on_a_display_whose_shape_matches_keeps_the_plain_banner(fppd, audio):
    """The same refusal on a display whose EDID shape matches its mode
    (520x290 mm at 1920x1080, both 16:9) has another cause, such as the
    Pi 0-3 display load limit, so the banner keeps the plain reason, now
    as warning 74 (Display Refused Video) rather than 31. Fixed by
    ab6c8cdf9."""
    w = play_refused(fppd)
    assert w["id"] == REFUSED_WARNING_ID and "No space left on device" in w["message"] \
        and "screen shape" not in w["message"], \
        f"a matching display was blamed on its shape: {w!r}"


def test_a_live_source_on_the_projector_is_told_which_resolution_to_set(fppd, audio):
    """A camera group (an Advanced-mode video input, here a test pattern)
    shown on the same projector: its own kmssink, in VideoOutputManager's
    consumer pipeline, is refused the same way, and the banner says which
    resolution to set.

    Fixed by 6159b0dbc, which calls AspectMismatchWarning() from the
    consumer pipeline's error handler. Before it the failure
    was only logged ("Consumer 'HDMI: 1' error") and the consumer restarted,
    2 s to 60 s apart, with nothing on screen to say why."""
    from test_video import hdmi_consumer, setup, source
    camera = dict(hdmi_consumer(1, connector_id=35, card="/dev/dri/card0", group=3),
                  connector=CONNECTOR)
    setup(fppd, [camera], [source("videotestsrc", pattern="smpte")])
    preload, env = fakedrm.start_env(fppd, mm="1600x900", preferred="1280x800", refuse_planes=True)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "Consumer 'HDMI: 1' error" in fppd.log(), timeout=20,
                  what="the camera's kmssink to be refused (precondition)")
    fppd.wait_for(lambda: video_warning(fppd), timeout=5, what="the video output banner")
    assert_names_the_fix(video_warning(fppd))


def test_on_a_pi_the_banner_names_the_setting(fppd, audio):
    """Hardware only: a Raspberry Pi whose HDMI-A-1 has the projector's EDID
    (drm.edid_firmware=HDMI-A-1:edid/epson.bin on the kernel command line),
    with the real kmssink and nothing else holding the display (stop the
    device's own fppd first). The Pi build names the setting and the menu
    path to it (c19d8e5ed). Verified with run-local.sh on a Pi 3B+ running
    1280x800."""
    with open("/proc/cmdline") as f:
        cmdline = f.read()
    try:
        with open("/proc/device-tree/model") as f:
            model = f.read()
    except OSError:
        model = ""
    if "Raspberry Pi" not in model or not re.search(r"drm\.edid_firmware=\S*HDMI-A-1:\S*epson", cmdline):
        pytest.skip("needs a Pi with the Epson projector's EDID on HDMI-A-1")
    forced = re.search(r"video=HDMI-A-1:(\d+)x(\d+)", cmdline)
    if forced and abs(int(forced[1]) / int(forced[2]) - 16 / 9) < 0.02:
        pytest.skip("Force HDMI Resolution is a 16:9 mode: the workaround is already applied")
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    video = "Wide720.mkv"
    make_video(os.path.join(fppd.media, "videos", video), seconds=5, width=1280, height=720, fps=10, audio=False)
    fppd.start()
    fppd.command("Play Media", video, "1", "0", "1", CONNECTOR)
    fppd.wait_for(lambda: video_warning(fppd), timeout=20, what="the video output banner")
    w = video_warning(fppd)
    assert w["id"] == REFUSED_WARNING_ID, f"the banner isn't warning {REFUSED_WARNING_ID}: {w!r}"
    assert "Set Status/Control > FPP Settings > Audio/Video > Force HDMI Resolution to 1280x720@60 and reboot." \
        in w["message"], f"the banner doesn't name the setting: {w!r}"
