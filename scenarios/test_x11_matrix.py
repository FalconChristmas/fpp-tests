"""The X11Matrix output, a window on an X server showing the channels as a
scaled-up grid of pixels, on fakex11.c's stand-in for the server.
"""

import os

import pytest

import shims
from test_display_outputs import x11_frame


def start(fppd, start_channel=1, channels=24, **config):
    """fppd with one X11Matrix output; the path of the image it last drew."""
    if not os.path.exists(os.path.join(fppd.tree, "src", "libfpp-co-X11Matrix.so")):
        pytest.skip("no X11Matrix output in this build (no X11 headers)")
    fppd.write("config/channeloutputs.json", {"channelOutputs": [dict(
        {"type": "X11Matrix", "enabled": 1, "startChannel": start_channel, "channelCount": channels},
        **config)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    frame_file = os.path.join(fppd.media, "tmp", "x11-frame")
    fppd.start(preload=[shims.build("fakex11.c")], extra_env={"FAKEX11_FILE": frame_file})
    return frame_file


def lit(frame_file):
    """{(x, y): (r, g, b)} of the image's pixels that aren't black."""
    frame = x11_frame(frame_file)
    if frame is None:
        return None
    return {(x, y): p for y, row in enumerate(frame) for x, p in enumerate(row) if p != (0, 0, 0)}


def wait_for_image(fppd, frame_file, want):
    """Wait for the image's lit pixels to be `want`, and say what it showed if
    they never are."""
    try:
        fppd.wait_for(lambda: lit(frame_file) == want, timeout=10, what="the image")
    except TimeoutError:
        pytest.fail(f"wanted {sorted(want.items())}, the image showed {sorted((lit(frame_file) or {}).items())}")


def block(x, y, scale, colour):
    """The image's pixels showing channel pixel (x, y) at this scale."""
    return {(x * scale + i, y * scale + j): colour for i in range(scale) for j in range(scale)}


@pytest.mark.parametrize("start_channel", [1, 101], ids=["from-channel-1", "from-channel-101"])
def test_each_pixel_shows_its_own_channels_scaled_up(fppd, start_channel):
    """A 4x2 matrix at scale 3 draws a 12x6 image. The output's channels fill
    it row by row, red then green then blue, so one channel lit in the second
    pixel of the first row and one in the first pixel of the second row show
    as 3x3 blocks in those colours, wherever the output starts."""
    frame_file = start(fppd, start_channel, width=4, height=2, scale=3, title="fpp-tests")
    red = start_channel + 3      # pixel (1, 0), R
    green = start_channel + 13   # pixel (0, 1), G
    blue = start_channel + 23    # pixel (3, 1), B: the output's last channel
    for channel, value in ((red, 200), (green, 100), (blue, 50)):
        fppd.request("PUT", f"/overlays/range/{channel}-{channel}", {"Value": value})
    want = {**block(1, 0, 3, (200, 0, 0)), **block(0, 1, 3, (0, 100, 0)), **block(3, 1, 3, (0, 0, 50))}
    wait_for_image(fppd, frame_file, want)
    frame = x11_frame(frame_file)
    assert (len(frame[0]), len(frame)) == (12, 6)


def test_a_matrix_with_no_scale_draws_ten_times_its_size(fppd):
    """The scale is optional: a matrix without one shows each pixel as a
    10x10 block."""
    frame_file = start(fppd, channels=6, width=2, height=1)
    fppd.request("PUT", "/overlays/range/4-6", {"Value": 255})
    want = block(1, 0, 10, (255, 255, 255))
    wait_for_image(fppd, frame_file, want)
    frame = x11_frame(frame_file)
    assert (len(frame[0]), len(frame)) == (20, 10)


@pytest.mark.parametrize("config", [
    {"width": 100, "height": 100, "scale": 1},
    {"width": 0, "height": 2, "scale": 1},
    {"width": 2, "height": 2, "scale": 101},
], ids=["more-pixels-than-channels", "no-width", "scale-too-large"])
def test_a_size_the_output_cannot_draw_is_refused(fppd, config):
    """A matrix bigger than the output's channels, with no width, or scaled
    past the limit never opens a window, says why in the log, and leaves
    fppd running."""
    frame_file = start(fppd, **config)
    fppd.wait_for(lambda: "X11Matrix: invalid size" in fppd.log(), timeout=10,
                  what="the output to refuse its size")
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 255})
    assert x11_frame(frame_file) is None
    assert fppd.get("/fppd/status").get("fppd") == "running"
