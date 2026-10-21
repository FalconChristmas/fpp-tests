"""How an HDMI member of a video group fits a picture of another shape to
its display: "fit" (letterbox), "fill" (crop to the display's shape) or
"stretch". The display is a stand-in kmssink (vid_kmscaps.c) that records
the size and the brightness of the top and middle of the first frame it
gets; the source is a 16:9 test pattern and the display 4:3 (800x600).
"""

import glob
import os
import subprocess

import pytest

import shims
from test_video import SOURCE, hdmi_consumer, setup, source

DISPLAY = (800, 600)


def kms_env(fppd):
    """fppd's environment with vid_kmscaps.c as the only kmssink (as
    test_video.fake_kms_env() does for fakekms.c)."""
    core = glob.glob("/usr/lib/*/gstreamer-1.0/libgstcoreelements.so")
    if not core:
        pytest.skip("GStreamer's system plugin directory was not found")
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0", "gstreamer-base-1.0"],
                           capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the GStreamer development files are not installed")
    so = shims.build("vid_kmscaps.c", libs=("-ldl", *flags.stdout.split()))
    farm = os.path.join(fppd.media, "tmp", "gst-plugins")
    os.makedirs(farm)
    system = os.path.dirname(core[0])
    for name in os.listdir(system):
        if name.endswith(".so") and name != "libgstkms.so":
            os.symlink(os.path.join(system, name), os.path.join(farm, name))
    os.symlink(so, os.path.join(farm, "libgstvidkmscaps.so"))
    return {"GST_PLUGIN_SYSTEM_PATH_1_0": farm,
            "GST_REGISTRY_1_0": os.path.join(fppd.media, "tmp", "gst-registry.bin"),
            "VIDKMS_LOG": os.path.join(fppd.media, "tmp", "vidkms.log")}


def shapes(fppd):
    """[(width, height, top, middle)] the display was shown, in order."""
    try:
        with open(os.path.join(fppd.media, "tmp", "vidkms.log")) as f:
            return [tuple(int(v) for v in l.split()[3:7]) for l in f if l.startswith("shape ")]
    except FileNotFoundError:
        return []


def show(fppd, scaling, size=DISPLAY):
    member = hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)
    member["scaling"] = scaling
    member["width"], member["height"] = size
    setup(fppd, [member], [source("videotestsrc", pattern="smpte", width=320, height=180)])
    fppd.start(extra_env=kms_env(fppd))
    return fppd.wait_for(lambda: shapes(fppd), timeout=20, what="the display's first frame")[0]


# A black row is 0; the bars' rows are hundreds (R+G+B of 75% colours).
DARK, LIT = 40, 150


def test_fit_letterboxes_a_wider_picture(fppd, audio):
    """"fit" (the default) shows the whole 16:9 picture on the 4:3 display,
    with black bands above and below.

    Feature: b39982025 (the three modes; fit is what was there before)."""
    w, h, top, mid = show(fppd, "fit")
    assert (w, h) == DISPLAY, f"the display got {w}x{h}"
    assert top < DARK and mid > LIT, f"top {top}, middle {mid}: not letterboxed"


def test_fill_crops_the_picture_to_the_displays_shape(fppd, audio):
    """"fill" hands the display a centre crop of the picture in the
    display's own shape (4:3), so it covers the whole panel with no bands.

    Feature: b39982025. Before it, "fill" was ignored and showed as fit."""
    w, h, top, mid = show(fppd, "fill")
    assert abs(w / h - 4 / 3) < 0.02, f"the display got {w}x{h}, not 4:3"
    assert h == 180, f"the display got {w}x{h}: the crop should keep the full height"
    assert top > LIT and mid > LIT, f"top {top}, middle {mid}: the picture has bands"


def test_stretch_fills_the_display_without_bands(fppd, audio):
    """"stretch" scales the picture to the display's exact size, aspect
    ratio ignored: 800x600 with no black bands.

    Feature: b39982025. Before it, "stretch" was ignored and showed as fit."""
    w, h, top, mid = show(fppd, "stretch")
    assert (w, h) == DISPLAY, f"the display got {w}x{h}"
    assert top > LIT and mid > LIT, f"top {top}, middle {mid}: the picture has bands"


def test_stretch_without_a_display_size_falls_back_to_fit(fppd, audio):
    """"stretch" for a display whose size isn't known shows the picture
    fitted, as it comes, and says why in the log.

    Feature: b39982025."""
    w, h, top, mid = show(fppd, "stretch", size=(0, 0))
    assert (w, h) == (320, 180), f"the display got {w}x{h}"
    assert "asked for stretch but the display size is unknown" in fppd.log()
