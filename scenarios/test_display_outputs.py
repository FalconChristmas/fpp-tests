"""Virtual Matrix outputs and FB models on a fake framebuffer
(framebuffer.py), and the HTTP Virtual Display's map and background
image: models re-created under an output, page counts, map pixels outside
the preview, and a background image GraphicsMagick fails on."""

import json
import os
import time

import pytest

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


def test_virtual_matrix_flips_horizontally(fppd):
    """A Virtual Matrix saved with Flip Horizontal draws each row mirrored:
    its first pixel lit, and only that one, comes out at the right-hand end
    of the top row of the device.

    Regression: 53462480f. FBMatrix read only "invert" (the vertical flip),
    so a horizontally flipped matrix drew its first pixel at the top left,
    as if the box were not ticked.
    """
    fb = FakeFb(fppd, width=W, height=H, bpp=32)
    out = virtual_matrix(W, H)
    out["flipHorizontal"] = True  # as the output page saves the box
    fppd.write("config/co-other.json", {"channelOutputs": [out]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fb.start()
    fppd.command("Test Start", 1000, "RGB Single Color", "1-3", "#FF8001")

    def lit():
        if fb.mode() is None:
            return []
        return [(x, y) for y, row in enumerate(fb.pixels()) for x, p in enumerate(row) if p != (0, 0, 0)]
    fppd.wait_for(lit, timeout=10, what="the matrix's first pixel on the device")
    time.sleep(0.5)  # a frame or two more, in case anything else lights
    assert lit() == [(W - 1, 0)], f"lit at {lit()}, expected only the top right ({W - 1}, 0)"
    assert fb.pixels()[0][W - 1] == (255, 128, 1)


def map_files_open(fppd):
    """fppd's open descriptors on the virtual display map."""
    path = os.path.realpath(os.path.join(fppd.media, "config", "virtualdisplaymap"))
    fds = []
    for fd in os.listdir(f"/proc/{fppd.proc.pid}/fd"):
        try:
            if os.readlink(f"/proc/{fppd.proc.pid}/fd/{fd}") == path:
                fds.append(fd)
        except OSError:
            pass
    return fds


def output_reloads(fppd, name="co-other.json"):
    return sum(1 for line in fppd.log().splitlines()
               if "Reloading Channel Outputs for " in line and line.rstrip().endswith("/" + name))


def save_http_display_again(fppd, times):
    """Save the HTTP Virtual Display's config `times` more times, a second
    apart as a person makes them, waiting for fppd to reload it each time."""
    path = os.path.join(fppd.media, "config", "co-other.json")
    for i in range(times):
        base = output_reloads(fppd)
        with open(path) as f:
            co = json.load(f)
        co["channelOutputs"][0]["description"] = f"save {i}"
        time.sleep(1.1)
        fppd.write("config/co-other.json", co)
        fppd.wait_for(lambda: output_reloads(fppd) > base, timeout=10, what=f"the reload for save {i}")
    time.sleep(1)  # the last reload's display is up


def test_virtual_display_reload_closes_its_map(fppd):
    """Saving an HTTP Virtual Display's config five times re-reads its map
    five times, and fppd holds the map open none of those times.

    Regression: 240ed5db6. InitializePixelMap() never closed the map it
    read, so every load of a virtual display leaked a descriptor on it:
    six open here, one for the startup load and one for each save.
    """
    from test_output_config import virtual_display as http_display
    http_display(fppd, ["100,100", "2,2,0,3,RGB", "5,5,3,3,RGB"], 6)
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start()
    wait_for_display(fppd)
    fppd.wait_for(lambda: output_reloads(fppd) >= 1, timeout=10, what="the startup load of co-other.json")
    save_http_display_again(fppd, 5)
    open_maps = map_files_open(fppd)
    assert not open_maps, f"fppd holds the map open {len(open_maps)} times after 6 loads (fds {open_maps})"


def listeners(port):
    """Listening TCP sockets on `port`, IPv4 and IPv6."""
    count = 0
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as f:
                rows = f.read().splitlines()[1:]
        except OSError:
            continue
        for row in rows:
            cols = row.split()
            if int(cols[1].rsplit(":", 1)[1], 16) == port and cols[3] == "0A":
                count += 1
    return count


def test_http_virtual_display_reload_closes_its_socket(fppd):
    """Saving an HTTP Virtual Display's config four times leaves one socket
    listening on its port, the new display's, and every one of 20 browsers
    connecting afterwards gets the event stream.

    Regression: 132a13101. The display's destructor never closed its
    listening socket. With SO_REUSEPORT, as then, the next display could
    still bind the port, so the kernel spread new connections over all five
    sockets listening on it, and the ones it gave to the four old sockets,
    which no thread accepted from any more, were left hanging with no reply.
    (With the fix reverted on today's code, which binds with SO_REUSEADDR
    only, the new display can't bind at all, and every connection goes to
    the first display's dead socket.)
    """
    import socket
    from test_output_config import VD_PORT, virtual_display as http_display
    http_display(fppd, ["100,100", "2,2,0,3,RGB"], 3)
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start()
    wait_for_display(fppd)
    fppd.wait_for(lambda: output_reloads(fppd) >= 1, timeout=10, what="the startup load of co-other.json")
    save_http_display_again(fppd, 4)
    wait_for_display(fppd)
    assert listeners(VD_PORT) == 1, f"{listeners(VD_PORT)} sockets listening on {VD_PORT} after 4 saves"
    unanswered = 0
    for _ in range(20):
        try:
            with socket.create_connection(("127.0.0.1", VD_PORT), timeout=1) as s:
                if not s.recv(64).startswith(b"HTTP/1.1 200"):
                    unanswered += 1
        except TimeoutError:  # in connect() too, once a dead socket's backlog is full
            unanswered += 1
    assert not unanswered, f"{unanswered} of 20 connections got no event stream"


def x11_frame(path):
    """The last image the X11 output put (fakex11.c), as rows of (r, g, b),
    or None before the first."""
    try:
        with open(path, "rb") as f:
            head = f.readline().split()
            data = f.read()
    except FileNotFoundError:
        return None
    w, h = int(head[0]), int(head[1])
    return [[(data[(y * w + x) * 4 + 2], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4])
             for x in range(w)] for y in range(h)]


@pytest.mark.parametrize("submatrix", [False, True], ids=["plain", "submatrix"])
def test_x11_panel_matrix_past_channel_1_draws_its_own_channels(fppd, submatrix):
    """An X11 panel matrix (one 32x16 panel, on fakex11.c's stand-in for an
    X server) starting at channel 1537 puts up its own first pixel, and
    nothing else, without reading outside its buffer; with a 2x1 submatrix
    drawn from channels 1-6 at x = 4, the submatrix's two pixels as well.

    Regression: a00278ee1. RawSendData() is handed the double-buffered copy
    of just this output's 1536 channels, yet it moved on by the start
    channel before reading pixels, and ran the submatrix overlay on that
    copy too, whose source channels and enable flags are absolute sequence
    channels the copy does not hold: an ASan heap-buffer-overflow on the
    first frame, in the pixel loop (plain) or in the overlay's copy of the
    matrix out of channel 1537 (submatrix).
    """
    import shims
    if not os.path.exists(os.path.join(fppd.tree, "src", "libfpp-co-matrix-X11PanelMatrix.so")):
        pytest.skip("no X11PanelMatrix output in this build (no X11 headers)")
    pw, ph, start = 32, 16, 1537
    fppd.write("config/channeloutputs.json", {"channelOutputs": [{
        "type": "LEDPanelMatrix", "subType": "X11PanelMatrix", "enabled": 1,
        "startChannel": start, "channelCount": pw * ph * 3, "panelWidth": pw, "panelHeight": ph,
        "colorOrder": "RGB", "invertedData": 0, "scale": 1, "title": "fpp-tests",
        "panels": [{"outputNumber": 0, "panelNumber": 0, "colorOrder": "", "xOffset": 0,
                    "yOffset": 0, "orientation": "N"}],
        "subMatrices": [{"enabled": 1, "startChannel": 1, "width": 2, "height": 1,
                         "xOffset": 4, "yOffset": 0}] if submatrix else []}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    frame_file = os.path.join(fppd.media, "tmp", "x11-frame")
    fppd.start(preload=[shims.build("fakex11.c")], extra_env={"FAKEX11_FILE": frame_file})
    fppd.request("PUT", "/overlays/range/1-6", {"Value": 255})            # the submatrix's source, or no output's
    fppd.request("PUT", f"/overlays/range/{start}-{start + 2}", {"Value": 255})  # the output's first pixel

    def lit():
        frame = x11_frame(frame_file)
        if frame is None:
            return None
        return sorted((x, y) for y, row in enumerate(frame) for x, p in enumerate(row) if p != (0, 0, 0))
    want = [(0, 0), (4, 0), (5, 0)] if submatrix else [(0, 0)]
    fppd.wait_for(lambda: lit() == want, timeout=10, what=f"pixels {want} lit (last: {lit()})")
    assert all(p == (255, 255, 255) for p in (x11_frame(frame_file)[0][x] for x, _ in want))
