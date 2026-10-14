"""Framebuffer outputs on an fbtft SPI display.

Hardware-only: these need an fbtft framebuffer (/sys/class/graphics/fb*/name
"fb_<controller>") and skip without one. No panel has to be attached: on a
Pi, `dtoverlay piscreen` registers an ILI9486 fb_ili9486 device whether or
not a display answers on SPI. Verified with run-local.sh on a Pi 5 that way.
"""

import glob
import mmap
import os

import pytest


def fbtft_device():
    """(name, width, height, bits per pixel) of the first fbtft framebuffer."""
    for d in sorted(glob.glob("/sys/class/graphics/fb[0-9]*")):
        try:
            with open(os.path.join(d, "name")) as f:
                if not f.read().startswith("fb_"):
                    continue
            with open(os.path.join(d, "virtual_size")) as f:
                w, h = (int(v) for v in f.read().split(","))
            with open(os.path.join(d, "bits_per_pixel")) as f:
                bpp = int(f.read())
        except OSError:
            continue
        return os.path.basename(d), w, h, bpp
    return None


FB = fbtft_device()
pytestmark = pytest.mark.skipif(FB is None, reason="no fbtft framebuffer (try `dtoverlay piscreen` on a Pi)")


def virtual_display(fppd):
    """A Virtual Display on the fbtft device, as the output page saves it,
    with a map of one pixel every 20 device pixels."""
    name, w, h, _ = FB
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "VirtualDisplay", "startChannel": 1,
        "channelCount": 8388608, "modelName": "", "invert": False,
        "flipHorizontal": False, "device": name,
        "width": w, "height": h, "pixelSize": 2}]})
    lines = [f"{w},{h}"]
    ch = 0
    for y in range(0, h, 20):
        for x in range(0, w, 20):
            lines.append(f"{x},{y},{ch},3,RGB")
            ch += 3
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    return "FB - " + name


def framebuffer_bytes():
    name, w, h, bpp = FB
    fd = os.open("/dev/" + name, os.O_RDWR)
    try:
        with mmap.mmap(fd, w * h * bpp // 8) as m:
            return m[:]
    finally:
        os.close(fd)


def test_virtual_display_on_fbtft_starts(fppd):
    """A Virtual Display on an fbtft framebuffer starts without a crash.

    Regression: ed301a277. InitializeFrameBuffer() asked for two pages, and
    fbtft (no fb_check_var) answered FBIOPUT_VSCREENINFO with success without
    granting them. fppd mapped and cleared two pages of a one-page device and
    took SIGBUS at startup, then crash-looped under systemd.
    """
    model = virtual_display(fppd)
    fppd.start()
    models = fppd.get("/overlays/models")
    assert any(m["Name"] == model for m in models), f"no {model} model in {models}"
    assert "only has room for 1 of 2 pages" in fppd.log()


def test_fbtft_model_fill_reaches_the_display(fppd):
    """Filling the framebuffer model puts the colour in the device's memory.

    Regression: f3f0acf0c. The 16bpp FBCopyData() wrote the frame straight
    into the page, then DrawLoop() copied the empty output buffer over it,
    so every frame on a 16bpp device was drawn black.
    """
    if FB[3] != 16:
        pytest.skip(f"{FB[0]} is {FB[3]}bpp, the bug was in the 16bpp path")
    model = virtual_display(fppd)
    fppd.start()
    fppd.request("PUT", "/overlays/model/" + model.replace(" ", "%20") + "/state", {"State": 1})
    fppd.request("PUT", "/overlays/model/" + model.replace(" ", "%20") + "/fill", {"RGB": [255, 0, 0]})
    red = b"\x00\xf8"  # RGB565 little-endian
    pixels = FB[1] * FB[2]

    def red_pixels():
        d = framebuffer_bytes()
        return sum(1 for i in range(0, len(d), 2) if d[i:i + 2] == red)

    # The Virtual Display still draws its own (black) map pixels over the
    # fill, so not every pixel is red. Before the fix none of them were.
    fppd.wait_for(lambda: red_pixels() >= pixels * 9 // 10, timeout=5,
                  what=f"at least 90% of the {pixels} pixels of {FB[0]} red")
