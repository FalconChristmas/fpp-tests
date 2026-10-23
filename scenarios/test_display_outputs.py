"""Virtual Matrix outputs and FB models on a fake framebuffer
(framebuffer.py), and the HTTP Virtual Display's map and background
image: models re-created under an output, page counts, map pixels outside
the preview, and a background image GraphicsMagick fails on."""

import json
import os
import time

from framebuffer import FakeFb
from test_fbdev import fb_model, image, send, shows, virtual_display
from test_output_config import B64, sse_messages, wait_for_display

W, H = 64, 32


def virtual_matrix(width, height, start=1, device="fb1", model=""):
    out = {"enabled": 1, "type": "VirtualMatrix", "startChannel": start,
           "channelCount": width * height * 3, "width": width, "height": height,
           "invert": 0, "flipHorizontal": 0}
    if model:
        out["modelName"] = model
    else:
        out["device"] = device
    return out


def test_two_virtual_matrices_on_one_device_at_different_sizes(fppd):
    """Two Virtual Matrix outputs on the same device, 32x16 and then 64x32,
    run through a test pattern without reading past either one's buffer:
    the first lets go of the device's model when the second re-creates it
    at its own size, and says so.

    Regression: 7e2bc8813. Both outputs share the "FB - fb1" model name, so
    the second one's Init() replaced the model at 64x32 and the first
    output's listener followed it; its SendData() then handed its 32x16
    buffer to setData(), which copied the model's 64x32 out of it: an ASan
    heap-buffer-overflow on the first frame.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", {"channelOutputs": [
        virtual_matrix(32, 16), virtual_matrix(W, H, start=32 * 16 * 3 + 1)]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 100, "RGB Cycle", f"1-{(32 * 16 + W * H) * 3}", "R-G-B")
    time.sleep(3)
    fppd.check_alive()
    assert "this output is 32x16; detaching" in fppd.log(), \
        "the first output never saw the model re-created at another size"


def test_virtual_matrix_on_a_model_another_output_recreates(fppd):
    """A Virtual Matrix drawing into a model that a Virtual Display
    auto-creates keeps running while the display's config is saved again
    and again, which frees that model and creates a new one each time.

    Regression: f745a3ad0 (the FBMatrix half). The Virtual Matrix kept the
    model pointer it found in Init() and never heard the model go away, so
    its next frame called into the freed one: an ASan heap-use-after-free
    after the first save.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    fppd.write("config/co-other.json", virtual_display(description="a"))
    fppd.write("config/co-pwm.json", {"channelOutputs": [virtual_matrix(W, H, model="FB - fb1")]})
    fppd.write("config/virtualdisplaymap", f"{W},{H}\n10,5,0,3,RGB\n")
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 100, "RGB Cycle", f"1-{W * H * 3}", "R-G-B")
    fppd.wait_for(lambda: fb.mode() is not None and any(p != (0, 0, 0) for row in fb.pixels() for p in row),
                  timeout=10, what="something drawn on the device")
    for i in range(4):
        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-other.json", virtual_display(description=f"save {i}"))
        time.sleep(1)
        fppd.check_alive()
    with open(fb.path, "r+b") as f:  # wipe the screen: what is lit next is new
        f.write(bytes(os.path.getsize(fb.path)))
    fppd.wait_for(lambda: any(p != (0, 0, 0) for row in fb.pixels() for p in row),
                  timeout=10, what="the device drawn again after the saves")


def test_framebuffer_page_count_past_its_buffers_is_clamped(fppd):
    """An FB model asking for 8 pages, on a device with the memory for
    them, uses the three pages it has buffers for, says so, and keeps
    drawing image after image.

    Regression: e01a8892a. The page count went in unchecked while only
    three page buffers exist: page flipping walked on to page 3, whose
    buffer was never assigned, and the next draw wrote through a null
    pointer.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32, pages=8)
    fb_model(fppd, Pages=8)
    fb.start()
    img = image(W, H)
    for i in range(12):
        shade = [[((r + i * 16) & 0xFF, g, b) for r, g, b in row] for row in img]
        send(fppd, shade)
        fppd.wait_for(lambda: shows(fb, shade), timeout=10, what=f"image {i} on the device")
    assert "Pages=8 out of range" in fppd.log()


def test_http_virtual_display_skips_a_pixel_with_no_position(fppd):
    """A map line at x, y = INT_MIN (a model with no layout position, as
    the exporter writes it) is skipped with a log line; the display
    streams the other pixel and fppd lives.

    Regression: 589d8b8ff. INT_MIN went through the scale into an int
    unchecked, which put the pixel's buffer offset gigabytes outside the
    preview buffer, and PrepData() faulted reading it on the first frame.
    """
    from test_output_config import virtual_display as http_display
    http_display(fppd, ["100,100", "2,2,0,3,RGB", "-2147483648,-2147483648,3,3,RGB"], 6)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-6", {"Value": 200})
    want = B64[200 >> 2] * 3
    msgs = sse_messages(3)
    assert any(m.startswith(want + ":") for m in msgs), f"no {want!r} pixel in {msgs[-3:]}"
    assert "lie outside the 100x100 preview and were skipped" in fppd.log()


def test_http_virtual_display_skips_a_background_image_it_cannot_convert(fppd):
    """A background image GraphicsMagick reads but then fails to convert
    for the display is skipped with a log line; the display streams its
    pixel and fppd lives.

    Regression: 6ed6169b2. The exception handler only logged, and the copy
    went ahead with what the failed conversion left: here a 300x300 scaled
    image and a blob GraphicsMagick never filled (64 KiB, length 0),
    which it read 360000 bytes out of: an ASan heap-buffer-overflow in
    LoadBackgroundImage() as the output starts. GraphicsMagick's width
    limit (MAGICK_LIMIT_WIDTH; fppd sets only the pixel limit itself) is
    what fails the conversion: the 100x100 image reads under it, and the
    scale up to fit the 400x300 preview goes over it. A truncated or
    corrupt image, the other case the fix is about, makes GraphicsMagick
    (as Debian 13 ships it) return no image at all, which the old copy
    already survived, so it can't show the fix.
    """
    from test_output_config import virtual_display as http_display
    name = f"fpp-tests-bg-{os.getpid()}-{time.monotonic_ns()}.ppm"
    path = os.path.join("/home/fpp/media/images", name)  # LoadBackgroundImage's fixed dir
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pix = bytes(v for y in range(100) for x in range(100) for v in (x * 2, y * 2, 128))
    with open(path, "wb") as f:
        f.write(b"P6\n100 100\n255\n" + pix)
    try:
        http_display(fppd, ["400,300", "2,2,0,3,RGB"], 3)
        with open(os.path.join(fppd.media, "config/co-other.json")) as f:
            co = json.load(f)
        co["channelOutputs"][0]["backgroundFilename"] = name
        fppd.write("config/co-other.json", co)
        fppd.start(extra_env={"MAGICK_LIMIT_WIDTH": "200"})
        wait_for_display(fppd)
        assert f"GraphicsMagick exception reading {path}" in fppd.log(), \
            "the background image did not fail to convert, so this tested nothing"
        fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
        want = B64[200 >> 2] * 3
        msgs = sse_messages(3)
        assert any(m.startswith(want + ":") for m in msgs), f"no {want!r} pixel in {msgs[-3:]}"
    finally:
        os.remove(path)
