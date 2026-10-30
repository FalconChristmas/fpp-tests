"""Framebuffer outputs on a fake /dev/fbN (framebuffer.py), so the fbdev
path (FrameBuffer and IOCTLFrameBuffer) runs anywhere: an FB overlay model
fed through the bulk pixel API, and the Virtual Display output.

What a real display adds -- scanout, vsync timing, a driver's own
quirks -- is out of reach here; test_framebuffer.py covers fbtft on a Pi.
The KMS path (KMSFrameBuffer) needs a DRM device and is not reached.
"""

import json
import os
import time

import pytest

from framebuffer import FakeFb

W, H = 64, 32
MODEL = "Screen"


def image(w, h):
    """A w x h RGB image whose pixels are all different, and stay different
    in RGB565: (x mod 32, y, x div 32) in the top bits of each channel."""
    return [[((x & 31) << 3, (y & 63) << 2, (x >> 5) << 3) for x in range(w)] for y in range(h)]


def raw(img):
    return bytes(c for row in img for px in row for c in px)


def fb_model(fppd, width=W, height=H, **extra):
    m = {"Name": MODEL, "Type": "FB", "Width": width, "Height": height, "Device": "fb1"}
    m.update(extra)
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [m]})
    fppd.settings(DisableFakeNetworkBridges="1")


def send(fppd, img):
    fppd.request("PUT", f"/overlays/model/{MODEL}/data?autoEnable=true&stopEffect=false", raw(img))


def shows(fb, want):
    """The page on screen is `want` (rows of (r, g, b)), to the precision
    of the device's pixel format."""
    if fb.mode() is None:
        return False
    got = fb.pixels()
    mask = (0xF8, 0xFC, 0xF8) if fb.mode()[4] == 16 else (0xFF, 0xFF, 0xFF)
    for y, row in enumerate(want):
        for x, px in enumerate(row):
            if tuple(a & m for a, m in zip(got[y][x], mask)) != tuple(a & m for a, m in zip(px, mask)):
                return False
    return True


def scaled(img, n):
    return [[px for px in row for _ in range(n)] for row in img for _ in range(n)]


def test_a_model_is_drawn_on_the_device(fppd):
    """Pixels sent to an FB model come out on the device where they belong.
    A driver reporting 32bpp is switched to 24bpp, with pages for page
    flipping in its video memory."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd)
    fb.start()
    img = image(W, H)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, img), timeout=10, what="the image on the device")
    xres, yres, xv, yv, bpp, _ = fb.mode()
    assert (xres, yres, bpp) == (W, H, 24)
    assert yv == 2 * H, "two pages for page flipping"


def test_a_16bpp_device_gets_rgb565(fppd):
    """A 16bpp device keeps its depth and gets each pixel as RGB565."""
    fb = FakeFb(fppd, width=W, height=H, bpp=16)
    fb_model(fppd)
    fb.start()
    img = image(W, H)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, img), timeout=10, what="the image on the device")
    assert fb.mode()[4] == 16


def test_pixel_size_draws_each_model_pixel_as_a_square(fppd):
    """PixelSize 2 makes a 32x16 model of the 64x32 device, each model pixel
    a 2x2 square."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd, PixelSize=2)
    fb.start()
    img = image(W // 2, H // 2)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, scaled(img, 2)), timeout=10, what="the image doubled on the device")


def test_a_small_model_is_scaled_to_the_device(fppd):
    """A model half the device's size in each direction, with no PixelSize,
    is scaled up to fill it."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd, width=W // 2, height=H // 2)
    fb.start()
    img = image(W // 2, H // 2)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, scaled(img, 2)), timeout=10, what="the image doubled on the device")


def test_a_model_bigger_than_the_device_is_cropped(fppd):
    """A model wider and taller than the device shows its top-left corner,
    with a warning, rather than writing past the page.

    Regression: 33e7e5867. The copy into the device's page was not clipped
    to it, so the model's extra rows and columns wrote past the image
    buffer (an ASan heap-buffer-overflow), with no warning.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd, width=W + 32, height=H + 16)
    fb.start()
    img = image(W + 32, H + 16)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, [row[:W] for row in img[:H]]), timeout=10,
                  what="the top-left of the image on the device")
    assert "does not fit the 64x32 display" in fppd.log()


def test_an_fbtft_style_device_with_one_page(fppd):
    """A driver that ignores mode changes and has one page of memory (fbtft)
    is drawn single-buffered rather than past its memory.

    Regression: ed301a277 (SIGBUS mapping two pages of a one-page device).
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=16, pages=1, fixed=True)
    fb_model(fppd)
    fb.start()
    img = image(W, H)
    send(fppd, img)
    fppd.wait_for(lambda: shows(fb, img), timeout=10, what="the image on the device")
    assert "only has room for 1 of 2 pages" in fppd.log()


TRANSITIONS = ["SlideUp", "SlideDown", "SlideLeft", "SlideRight", "WipeUp", "WipeDown", "WipeLeft",
               "WipeRight", "WipeToHCenter", "WipeFromHCenter", "HorzBlindsOpen", "HorzBlindsClose", "Mosaic"]


@pytest.mark.parametrize("size", [(64, 32), (48, 33)], ids=["64x32", "48x33"])
@pytest.mark.parametrize("transition", range(1, len(TRANSITIONS) + 1), ids=TRANSITIONS)
def test_a_transition_ends_on_the_new_image(fppd, transition, size):
    """Each transition from one image to the next ends with the new image
    on screen, whole, on a screen its steps divide and on one they don't.

    Regressions: 52fca0ec1 -- DrawLoop() cleared its image-ready flag after a
    transition, so an image that arrived while one was finishing (most sleep
    after their last step) was never drawn: here the second image, sent as
    soon as the first is on screen. 4ff96ee6e -- HorzBlindsOpen copied the
    row past the end of the page, Mosaic drew squares off the right and
    bottom edges, the wipes overran on odd heights (ASan), and the slides
    left rows of the old image where their step didn't divide the height.
    """
    w, h = size
    fb = FakeFb(fppd, width=w, height=h, bpp=32)
    fb_model(fppd, width=w, height=h, TransitionType=str(transition))
    fb.start()
    first = image(w, h)
    send(fppd, first)
    fppd.wait_for(lambda: shows(fb, first), timeout=10, what="the first image")
    second = [[(255 - r, 255 - g, 255 - b) for r, g, b in row] for row in first]
    send(fppd, second)
    fppd.wait_for(lambda: shows(fb, second), timeout=10, what="the second image after the transition")


def test_an_image_sent_during_a_transition_waits_for_it(fppd):
    """An image that arrives while a transition is drawing the one before
    it is drawn by its own transition afterwards: the running transition
    keeps revealing the image it started with.

    A top-down wipe of image 2 is under way when image 3 arrives. Image 2's
    rows are only ever above image 1's while it wipes in, and image 3's
    rows above image 2's while it does: a screen with image 2 on top of
    image 3 means image 3 leaked into image 2's wipe.

    Regression: 6d3c38544. FBCopyData() wrote each new image straight into
    the buffer the draw thread's transition was reading, so the rest of
    image 2's wipe revealed rows of image 3.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd, TransitionType=str(TRANSITIONS.index("WipeDown") + 1))
    fb.start()
    imgs = [image(W, H)]
    imgs.append([[(255 - r, 255 - g, 255 - b) for r, g, b in row] for row in imgs[0]])
    imgs.append([[(g, b, r) for r, g, b in row] for row in imgs[0]])
    send(fppd, imgs[0])
    fppd.wait_for(lambda: shows(fb, imgs[0]), timeout=10, what="the first image")
    time.sleep(1)  # its own wipe is over

    def rows():
        """Which image each row on screen comes from (None: none of them)."""
        return [next((i for i, img in enumerate(imgs) if row == img[y]), None)
                for y, row in enumerate(fb.pixels())]

    samples = []
    send(fppd, imgs[1])
    time.sleep(0.15)  # a row or two of image 2 is down
    send(fppd, imgs[2])
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        samples.append(rows())
        if samples[-1] == [2] * H:
            break
        time.sleep(0.02)
    assert samples[-1] == [2] * H, f"image 3 never filled the screen: {samples[-1]}"
    # the sampling saw image 2 part way in, or it proves nothing
    assert any(1 in s and set(s) != {1} for s in samples), samples
    for s in samples:
        twos = [y for y, i in enumerate(s) if i == 1]
        threes = [y for y, i in enumerate(s) if i == 2]
        assert not any(a < b for a in twos for b in threes), \
            f"rows of image 3 under image 2 while image 2 wiped in: {s}"


def test_virtual_display_draws_its_map(fppd):
    """A Virtual Display on the device draws each mapped pixel at its place
    in the preview, with y up, in the channel data's colour."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "VirtualDisplay", "startChannel": 1,
        "channelCount": 8388608, "modelName": "", "invert": False,
        "flipHorizontal": False, "device": "fb1",
        "width": W, "height": H, "pixelSize": 1}]})
    points = [(10, 5), (40, 20), (63, 0)]
    lines = [f"{W},{H}"] + [f"{x},{y},{i * 3},3,RGB" for i, (x, y) in enumerate(points)]
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 1000, "RGB Single Color", f"1-{len(points) * 3}", "#FF8001")

    def lit():
        if fb.mode() is None:
            return False
        px = fb.pixels()
        return [px[H - 1 - y][x] for x, y in points]
    fppd.wait_for(lambda: lit() and all(p == (255, 128, 1) for p in lit()), timeout=10,
                  what="the mapped pixels lit")
    others = [p for row in fb.pixels() for p in row if p != (0, 0, 0)]
    assert len(others) == len(points), f"{len(others)} lit pixels, expected {len(points)}"


def test_a_missing_device_is_reported(fppd):
    """A model on a framebuffer device that doesn't exist raises the
    "could not open device" warning, and fppd carries on without it.

    Regression: 8981357ea. open() failing returns -1, the check was for 0,
    so the failure surfaced as a failed ioctl on fd -1 with no warning.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fb_model(fppd, Device="fb9")
    fb.start()
    fppd.wait_for(lambda: any("could not open device" in w for w in
                              (x if isinstance(x, str) else x.get("message", "") for x in
                               fppd.get("/fppd/status").get("warnings", []))),
                  timeout=10, what="the could-not-open warning")


def virtual_display(device="fb1", model="", description=""):
    """A Virtual Display output: on `device` (auto-creating the "FB - fb1"
    model) when `model` is empty, otherwise drawing into that model."""
    return {"channelOutputs": [{
        "enabled": 1, "type": "VirtualDisplay", "startChannel": 1,
        "channelCount": 8388608, "modelName": model, "invert": False,
        "flipHorizontal": False, "device": device, "description": description,
        "width": W, "height": H, "pixelSize": 1}]}


def rgbw_model(fppd, name="W", width=16, height=8):
    """A Channel model with four channels a node, as an RGBW model is."""
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [{
        "Name": name, "Type": "Channel", "StartChannel": 1,
        "ChannelCount": width * height * 4, "ChannelCountPerNode": 4,
        "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": height, "StrandsPerString": 1}]})


def warned(fppd, text):
    return any(text in w for w in fppd.get("/fppd/status").get("warnings", []))


def test_virtual_display_follows_a_model_another_output_recreates(fppd):
    """A Virtual Display drawing into a model another output auto-creates
    survives that output's config being saved, which removes the model and
    creates a new one, and the device shows the map again afterwards.

    Here a Virtual Display on fb1 (co-other.json) creates "FB - fb1", and a
    second one (co-pwm.json, loaded after it) draws into that model by name.
    Each save of co-other.json removes and re-creates "FB - fb1". (Both
    displays draw the same map, so the pixels after the saves don't tell
    which one drew them.)

    Regression: a9720138d. The second display kept a bare pointer to the
    model, and its next frame drew into the freed one: a
    heap-use-after-free on the first frame after the first save.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", virtual_display(description="a"))
    fppd.write("config/co-pwm.json", virtual_display(device="", model="FB - fb1"))
    points = [(10, 5), (40, 20), (63, 0)]
    lines = [f"{W},{H}"] + [f"{x},{y},{i * 3},3,RGB" for i, (x, y) in enumerate(points)]
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 1000, "RGB Single Color", f"1-{len(points) * 3}", "#FF8001")

    def lit():
        if fb.mode() is None:
            return False
        px = fb.pixels()
        return all(px[H - 1 - y][x] == (255, 128, 1) for x, y in points)

    fppd.wait_for(lit, timeout=10, what="the mapped pixels lit")
    for i in range(5):
        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-other.json", virtual_display(description=f"save {i}"))
    time.sleep(2)
    fppd.check_alive()
    with open(fb.path, "r+b") as f:  # wipe the screen: what is lit next is new
        f.write(bytes(os.path.getsize(fb.path)))
    fppd.wait_for(lit, timeout=10, what="the mapped pixels lit after the saves")


def test_virtual_display_refuses_a_model_that_is_not_rgb(fppd):
    """A Virtual Display pointed at a model with four channels a node is
    refused with a warning, and fppd carries on.

    Regression: a9720138d. Init() handed the model its RGB buffer, and
    setData() read the model's own 4 bytes a pixel from it: a
    heap-buffer-overflow at startup.
    """
    rgbw_model(fppd)
    fppd.write("config/co-other.json", virtual_display(device="", model="W"))
    fppd.write("config/virtualdisplaymap", f"{W},{H}\n2,2,0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: warned(fppd, "is not an RGB model"), timeout=10,
                  what="the not-an-RGB-model warning")


def test_virtual_matrix_refuses_a_model_that_is_not_rgb(fppd):
    """A Virtual Matrix (FBMatrix) on a model with four channels a node is
    refused with a warning, and fppd lives through test mode over it.

    Regression: 965b29b0f. SendData() copied width x height x 4 bytes out
    of its width x height x 3 buffer into the model every frame: a
    heap-buffer-overflow on the first frame.
    """
    rgbw_model(fppd)
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "enabled": 1, "type": "VirtualMatrix", "startChannel": 1, "channelCount": 16 * 8 * 3,
        "modelName": "W", "width": 16, "height": 8}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Test Start", 1000, "RGB Cycle", "1-512", "R-G-B")
    fppd.wait_for(lambda: warned(fppd, "is not an RGB model"), timeout=10,
                  what="the not-an-RGB-model warning")
    time.sleep(2)


def test_virtual_display_warning_comes_down_when_the_model_is_fixed(fppd):
    """A Virtual Display pointed at a model that is not RGB raises "is not
    an RGB model"; pointing it at an RGB model and saving starts the
    display, and the warning comes down.

    Regression: 53594ea12. The virtual displays raised their Init()
    warnings with plain WarningHolder::AddWarning(), which nothing retracts
    on the next load of the config, so the banner stayed until fppd
    restarted.
    """
    rgbw_model(fppd)
    path = os.path.join(fppd.media, "config", "model-overlays.json")
    with open(path) as f:
        models = json.load(f)
    models["models"].append({  # an RGB model beside the RGBW one
        "Name": "RGB", "Type": "Channel", "StartChannel": 1, "ChannelCount": 16 * 8 * 3,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 8, "StrandsPerString": 1})
    fppd.write("config/model-overlays.json", models)
    fppd.write("config/co-other.json", virtual_display(device="", model="W"))
    fppd.write("config/virtualdisplaymap", "64,32\n2,2,0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: warned(fppd, "is not an RGB model"), timeout=10,
                  what="the not-an-RGB-model warning")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-other.json", virtual_display(device="", model="RGB"))
    fppd.wait_for(lambda: fppd.log().count("Init succeeded") >= 1, timeout=10,
                  what="the fixed display to start")
    fppd.wait_for(lambda: not warned(fppd, "is not an RGB model"), timeout=15, interval=0.5,
                  what="the warning to come down after the fix")


def test_a_virtual_display_takes_its_auto_created_model_with_it(fppd):
    """The model a Virtual Display on a device creates ("FB - fb1") is
    removed when the output goes: saving the outputs again creates it afresh
    without the "empty model name" warning (35) a lingering model caused,
    and saving them with no Virtual Display left removes it.

    Regression: 4375c60d3. Close() left the model it had created, so the
    next Init() found it, took it for one that already existed and gave up
    with the empty-model-name warning; the model was never cleaned up."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", virtual_display(description="first"))
    fppd.write("config/virtualdisplaymap", f"{W},{H}\n10,5,0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()

    def models():
        return [m["Name"] for m in fppd.get("/overlays/models")]
    fppd.wait_for(lambda: "FB - fb1" in models(), timeout=10, what="the auto-created model")
    for i in range(2):
        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-other.json", virtual_display(description=f"save {i}"))
        time.sleep(1.5)
        assert not warned(fppd, "empty Pixel Overlay Model name"), fppd.get("/fppd/status").get("warnings")
        assert models().count("FB - fb1") == 1, models()
    time.sleep(1.1)
    fppd.write("config/co-other.json", {"channelOutputs": []})
    fppd.wait_for(lambda: "FB - fb1" not in models(), timeout=10, what="the model to go with its output")


def test_a_virtual_display_pixel_size_draws_a_filled_circle(fppd):
    """A Virtual Display with a pixel size of 4 draws each mapped light as a
    disc of that size (radius 2) in the model, clipped to it, and nothing
    outside the disc.

    Feature: ea1611aac (pixel size support). Before it a pixel size of 2
    or more lit the pixel and its four neighbours, dimmed."""
    import math
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    cfg = virtual_display(description="discs")
    cfg["channelOutputs"][0]["pixelSize"] = 4
    fppd.write("config/co-other.json", cfg)
    x0, y0 = 30, 15
    fppd.write("config/virtualdisplaymap", f"{W},{H}\n{x0},{y0},0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 1000, "RGB Single Color", "1-3", "#FF8001")
    radius = 2
    want = {(x0 + xo, H - 1 - y0 + yo)
            for xo in range(-radius, radius) for yo in range(-radius, radius)
            if math.sqrt(xo * xo + yo * yo) <= radius}

    def lit():
        if fb.mode() is None:
            return None
        px = fb.pixels()
        return {(x, y) for y in range(H) for x in range(W) if px[y][x] == (255, 128, 1)}
    fppd.wait_for(lambda: lit() == want, timeout=10, what=f"the disc ({len(want)} pixels; lit {len(lit() or [])})")


def test_a_virtual_display_leaves_its_model_disabled(fppd):
    """The model a Virtual Display creates for its device starts disabled
    (isActive 0): the display draws the lights into it and only the model's
    overlay state decides whether it reaches the device.

    Regression: 8db386097. Init() switched the model on, so every start put
    the virtual display's image over whatever else the model was drawing."""
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", virtual_display(description="state"))
    fppd.write("config/virtualdisplaymap", f"{W},{H}\n10,5,0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.wait_for(lambda: [m for m in fppd.get("/overlays/models") if m["Name"] == "FB - fb1"], timeout=10,
                  what="the auto-created model")
    time.sleep(1)
    model = [m for m in fppd.get("/overlays/models") if m["Name"] == "FB - fb1"][0]
    assert model["isActive"] == 0, model
