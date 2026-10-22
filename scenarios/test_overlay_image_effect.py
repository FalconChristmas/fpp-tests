"""The "Image" pixel overlay effect (src/overlays/PixelOverlayEffects.cpp):
an image from the media dir's images/ drawn still in the middle of a model
or scrolled across it in each direction, ended by its Duration, by scrolling
off, or by Stop Effects part way, and checked pixel by pixel on the wire.

Every expected frame is built here from the image itself, the way the
effect places it:

- Center (ImageEffect::centerIntoFrame) puts the image's top-left at
  ((W - cols) / 2, (H - rows) / 2), C integer division, clipping whatever
  falls off the model.
- A scroll (ImageMovementEffect) starts with the image just off the model
  (x = W for Right to Left, x = -cols for Left to Right, y = H for Bottom
  to Top, y = -rows for Top to Bottom), moves it one pixel per update, one
  update every 1000 / Speed ms, and ends once it is off the far side
  (x = -cols, x = W, y = -rows, y = H). Across the other axis it sits at
  (int)(W / 2.0 - cols / 2.0) or (int)(H / 2.0 - rows / 2.0). Each frame
  clears the model and copies the image in at its position, clipped.

A scroll is checked as a sequence, never at set times: every lit frame on
the wire has to be exactly one of the positions, in order, and between them
they have to cover a good part of the run. Blank frames are skipped, since
they don't say where the image is. The output thread copies the model's
pixels out with no lock against the effect writing them, by design (see
sanitizers/tsan.supp), so a frame can now and then be torn between two
neighbouring positions; such a frame is accepted only if every byte of it
belongs to one of two consecutive positions, and only a few of them.

The PNGs are 8-bit RGB with no gamma or colour chunks, so GraphicsMagick
reads them unchanged, and imageToRGBBuffer's float trip (quantum / MaxRGB *
255, truncated) gives every 8-bit value back as itself at the Q16 build the
image ships (checked for all 256 values). "None" scaling leaves the image
alone; "Scale to Fit" while scrolling resizes it with aspect kept to the
model's height (or width), which GraphicsMagick's ResizeImage returns as a
plain clone when the size doesn't change, so an image already that high
comes through exactly.
"""

import struct
import time
import zlib

import pytest

from ddp import DdpReceiver
from test_overlays import CHANNELS, HEIGHT, WIDTH, effect, effect_done, fill, matrix, \
    running_effect, setup

SLOW = 5      # px/s: 200 ms a step, several output frames each
TORN_MAX = 3  # torn frames tolerated in one run (see the module docstring)


# --- images -------------------------------------------------------------------

class Img:
    def __init__(self, w, h, px):
        self.w, self.h = w, h
        self.px = px  # px(x, y) -> (r, g, b)


def distinct(w, h):
    """Every pixel a different colour, none of them black."""
    return Img(w, h, lambda x, y: (10 + 19 * x, 15 + 33 * y, 200 - 7 * x - 11 * y))


def flat(w, h, rgb):
    return Img(w, h, lambda x, y: rgb)


def write_png(fppd, name, img):
    """An 8-bit RGB PNG (colour type 2) in the media dir's images/."""
    raw = b"".join(b"\x00" + bytes(c for x in range(img.w) for c in img.px(x, y))
                   for y in range(img.h))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    fppd.write("images/" + name,
               b"\x89PNG\r\n\x1a\n" +
               chunk(b"IHDR", struct.pack(">IIBBBBB", img.w, img.h, 8, 2, 0, 0, 0)) +
               chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def place(img, xoff, yoff, w=WIDTH, h=HEIGHT, bpp=3):
    """The model's channels with `img` at (xoff, yoff), clipped, the rest
    black; a 4-channel model gets R, G, B and a W of 0."""
    out = bytearray(w * h * bpp)
    for y in range(img.h):
        for x in range(img.w):
            mx, my = xoff + x, yoff + y
            if 0 <= mx < w and 0 <= my < h:
                o = (my * w + mx) * bpp
                out[o:o + 3] = bytes(img.px(x, y))
    return bytes(out)


def cdiv(a, b):
    """C's integer division (truncates toward zero, unlike //)."""
    return int(a / b)


def scroll_positions(img, direction, w=WIDTH, h=HEIGHT):
    """(x, y) of every frame of a scroll, from the one drawn when it starts
    to the last, blank, one (ImageEffect::doImage, ImageMovementEffect::update)."""
    cy = int(h / 2.0 - img.h / 2.0)
    cx = int(w / 2.0 - img.w / 2.0)
    if direction == "Right to Left":
        return [(x, cy) for x in range(w, -img.w - 1, -1)]
    if direction == "Left to Right":
        return [(x, cy) for x in range(-img.w, w + 1)]
    if direction == "Bottom to Top":
        return [(cx, y) for y in range(h, -img.h - 1, -1)]
    if direction == "Top to Bottom":
        return [(cx, y) for y in range(-img.h, h + 1)]
    raise ValueError(direction)


# --- reading the wire ---------------------------------------------------------

def near(a, b, tol):
    return all(abs(p - q) <= tol for p, q in zip(a, b))


def follow(frames, expected, tol=0):
    """Where the image was in each lit frame: its index in `expected`, or
    None for a frame torn between two consecutive positions. Fails on a lit
    frame that is neither."""
    out = []
    for f in frames:
        if not any(f):
            continue
        k = next((i for i, e in enumerate(expected) if any(e) and near(f, e, tol)), None)
        if k is None:
            torn = any(all(abs(f[c] - expected[i][c]) <= tol or abs(f[c] - expected[i + 1][c]) <= tol
                           for c in range(len(f)))
                       for i in range(len(expected) - 1))
            assert torn, f"a frame on the wire is at no position of the image: {f.hex()}"
        out.append(k)
    return out


def check_scroll(frames, expected, what, tol=0, min_share=0.5):
    """`frames` show the image stepping through `expected` in order, and at
    least `min_share` of its lit positions; returns the indices seen."""
    idx = follow(frames, expected, tol)
    torn = idx.count(None)
    assert torn <= TORN_MAX, f"{what}: {torn} torn frames"
    seen = [k for k in idx if k is not None]
    assert seen == sorted(seen), f"{what}: the image went back: positions {seen}"
    lit = sum(1 for e in expected if any(e))
    distinct_seen = sorted(set(seen))
    assert len(distinct_seen) >= lit * min_share, \
        f"{what}: only {len(distinct_seen)} of {lit} positions seen: {distinct_seen}"
    return distinct_seen


def model(fppd, name="M"):
    return next(m for m in fppd.get("/overlays/models") if m.get("Name") == name)


def image_effect(fppd, image, position, scaling="None", speed=SLOW, duration=0):
    """The Image effect on M, Auto Enable "Enabled"."""
    return effect(fppd, "M", "Image", Scaling=scaling, Position=position, Speed=str(speed),
                  Duration=str(duration), Image=image)


def goes_dark(fppd, rx, hold=0.5):
    """The wire goes black and stays black for `hold` seconds. An effect
    that blanks the model and then disables it after the next output is
    done just before that output's frame is sent, so the black frame can
    land a moment after the effect is reported finished."""
    wait_frame(fppd, rx, lambda f: not any(f), "the model to go black", timeout=5)
    dark = time.monotonic()
    time.sleep(hold)
    assert not any(any(f) for _, f in rx.snapshot(dark)), "the image came back"


def wait_frame(fppd, rx, check, what, timeout=10):
    return fppd.wait_for(lambda: rx.last() is not None and check(rx.last()),
                         timeout=timeout, interval=0.02, what=what)


# --- scenarios ----------------------------------------------------------------

@pytest.mark.parametrize("direction", ["Right to Left", "Left to Right",
                                       "Bottom to Top", "Top to Bottom"])
def test_image_scrolls_across_the_model(fppd, direction):
    """A 4x3 image ("None" scaling) on a 10x5 model scrolls in from one edge
    and off the other, one pixel a step, centred across the other axis (row
    1, or column 3). Every lit frame on the wire is the image at one of those
    positions, in order. While it runs the model's effect is "Image"; at the
    end the effect is gone, the wire is black, and the model, which the
    effect enabled, is disabled again.

    Feature: afce7b609 (the Image effect; before it, there was none)."""
    img = distinct(4, 3)
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    expected = [place(img, x, y) for x, y in scroll_positions(img, direction)]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        assert model(fppd)["isActive"] == 0
        since = time.monotonic()
        image_effect(fppd, "pic.png", direction)
        assert running_effect(fppd, "M") == "Image"
        running = fppd.get("/overlays/running")
        assert [m["Name"] for m in running] == ["M"]
        assert running[0]["effect"]["name"] == "Image"
        effect_done(fppd, "M", timeout=20)
        frames = [f for _, f in rx.snapshot(since)]
        check_scroll(frames, expected, direction)
        goes_dark(fppd, rx)
        assert model(fppd)["isActive"] == 0, "the model the effect enabled was left enabled"


@pytest.mark.parametrize("img, direction, size, tol", [
    # Already the model's height: resized to its own size, so exact.
    (distinct(4, 5), "Right to Left", (4, 5), 0),
    # 3x10 to the height of 5: lround(3 * 5 / 10) = 2 wide.
    (flat(3, 10, (180, 90, 240)), "Right to Left", (2, 5), 2),
    # 20x6 to the width of 10: lround(6 * 10 / 20) = 3 high.
    (flat(20, 6, (60, 220, 130)), "Top to Bottom", (10, 3), 2),
], ids=["same-height", "taller", "wider"])
def test_scale_to_fit_scroll_fits_the_cross_axis(fppd, img, direction, size, tol):
    """"Scale to Fit" while scrolling (scaleToCrossAxis) resizes the image,
    aspect kept, to the model's height for a sideways scroll or its width
    for an up/down one, and it then runs past the ends as usual. An image
    already the model's height scrolls through exactly; a flat colour
    resized shows as a band of the computed size, every pixel within 2 of
    the colour (a resample of a flat area lands within a quantum of it)."""
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    scaled = Img(size[0], size[1], img.px) if tol else img
    expected = [place(scaled, x, y) for x, y in scroll_positions(scaled, direction)]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        since = time.monotonic()
        image_effect(fppd, "pic.png", direction, scaling="Scale to Fit")
        effect_done(fppd, "M", timeout=20)
        check_scroll([f for _, f in rx.snapshot(since)], expected,
                     f"{direction} at {size[0]}x{size[1]}", tol=tol)
        goes_dark(fppd, rx)


def test_scroll_on_a_model_already_enabled_leaves_it_enabled(fppd):
    """On a model that was enabled already (here by a fill), the scroll
    replaces the fill, runs to the end and leaves the model enabled and
    black: the effect only disables a model it enabled itself."""
    img = distinct(4, 3)
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    expected = [place(img, x, y) for x, y in scroll_positions(img, "Left to Right")]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fill(fppd, "M", [5, 5, 5])
        wait_frame(fppd, rx, lambda f: f == bytes([5]) * CHANNELS, "the fill")
        since = time.monotonic()
        image_effect(fppd, "pic.png", "Left to Right", speed=20)
        effect_done(fppd, "M", timeout=20)
        # The fill comes first: the effect's first frame (the image just
        # off the left edge) is all black, so the fill is gone from the start.
        check_scroll([f for _, f in rx.snapshot(since)], [bytes([5]) * CHANNELS] + expected,
                     "Left to Right", min_share=0.25)
        goes_dark(fppd, rx)
        assert model(fppd)["isActive"] == 1, "the model was disabled"


def test_duration_ends_a_scroll_part_way(fppd):
    """Duration stops a scroll that has not finished: at 2 px/s (an update
    every 500 ms) with Duration 2, the update due at 2 s finds the time up,
    so the image moves at most three steps (x = 9, 8, 7 of a 10-wide model)
    before the model is blanked and disabled, though scrolling off would
    take 14 steps."""
    img = distinct(4, 3)
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    positions = scroll_positions(img, "Right to Left")
    expected = [place(img, x, y) for x, y in positions]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        since = time.monotonic()
        image_effect(fppd, "pic.png", "Right to Left", speed=2, duration=2)
        effect_done(fppd, "M", timeout=10)
        seen = check_scroll([f for _, f in rx.snapshot(since)], expected, "Right to Left",
                            min_share=0)
        xs = [positions[k][0] for k in seen]
        assert xs, "the image never showed before the duration ended it"
        assert min(xs) >= 7, f"the image moved past the duration: x = {xs}"
        goes_dark(fppd, rx)
        assert model(fppd)["isActive"] == 0


@pytest.mark.parametrize("state, active_after", [("Enabled", 0), ("False", 1)])
def test_stop_effects_mid_scroll(fppd, state, active_after):
    """Stop Effects part way through a scroll ends it (StopRunningEffect):
    the model goes black and the image never comes back. Its Auto Enable
    argument says what happens to the model: anything but disabled
    ("Enabled") disables it, "False" leaves it enabled."""
    img = distinct(4, 3)
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    positions = scroll_positions(img, "Right to Left")
    expected = [place(img, x, y) for x, y in positions]
    middle = set(expected[4:9])  # x = 6 .. 2: well inside the model
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        image_effect(fppd, "pic.png", "Right to Left", speed=2)
        wait_frame(fppd, rx, lambda f: f in middle, "the image in the middle of the model")
        fppd.command("Overlay Model Effect", "M", state, "Stop Effects")
        effect_done(fppd, "M", timeout=5)
        goes_dark(fppd, rx, hold=1.5)  # three more steps, had it kept going
        assert running_effect(fppd, "M") is None
        assert model(fppd)["isActive"] == active_after


@pytest.mark.parametrize("img", [distinct(4, 3), distinct(13, 7)], ids=["smaller", "larger"])
def test_center_draws_the_image_in_the_middle_and_leaves_it_up(fppd, img):
    """Position Center with "None" scaling draws the image once, centred
    ((10 - 4) / 2 = 3, (5 - 3) / 2 = 1; a 13x7 image at (-1, -1), clipped),
    and with Duration 0 leaves it up: no effect stays running, and the
    model stays enabled and drawn."""
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    want = place(img, cdiv(WIDTH - img.w, 2), cdiv(HEIGHT - img.h, 2))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        image_effect(fppd, "pic.png", "Center")
        wait_frame(fppd, rx, lambda f: f == want, "the centred image")
        assert running_effect(fppd, "M") is None
        time.sleep(1.5)
        assert rx.last() == want, f"the image did not stay: {rx.last().hex()}"
        assert model(fppd)["isActive"] == 1


def test_center_with_a_duration_clears_and_disables(fppd):
    """Center with Duration 1: the image is drawn, then after a second the
    model is blanked and, since the effect enabled it, disabled."""
    img = distinct(4, 3)
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    want = place(img, 3, 1)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        image_effect(fppd, "pic.png", "Center", duration=1)
        assert running_effect(fppd, "M") == "Image"
        wait_frame(fppd, rx, lambda f: f == want, "the centred image")
        effect_done(fppd, "M", timeout=10)
        goes_dark(fppd, rx)
        assert model(fppd)["isActive"] == 0


def test_center_replaces_a_running_scroll(fppd):
    """A Center image on a model that is scrolling one ends the scroll:
    the centred image stays on the wire and nothing keeps moving it."""
    img = distinct(4, 3)
    still = flat(2, 2, (200, 30, 30))
    setup(fppd, [matrix()])
    write_png(fppd, "pic.png", img)
    write_png(fppd, "still.png", still)
    want = place(still, 4, 1)
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        image_effect(fppd, "pic.png", "Right to Left", speed=2)
        assert running_effect(fppd, "M") == "Image"
        image_effect(fppd, "still.png", "Center")
        wait_frame(fppd, rx, lambda f: f == want, "the centred image")
        effect_done(fppd, "M", timeout=5)
        since = time.monotonic()
        time.sleep(1.5)
        assert all(f == want for _, f in rx.snapshot(since)), "the scroll drew over the image"


def test_image_on_an_rgbw_model(fppd):
    """On a 4-channel (RGBW) model the effect's RGB pixels are spread to
    R, G, B with W 0, both for a centred image (setModelDataFromRGB) and for
    a scroll (ImageMovementEffect::copyImageData)."""
    img = distinct(4, 3)
    # Colours none of the scroll's frames has, so the two can't be confused.
    still = Img(2, 2, lambda x, y: (250 - 30 * x, 5 + 40 * y, 77))
    channels = WIDTH * HEIGHT * 4
    setup(fppd, [matrix(cpn=4)], channels=channels)
    write_png(fppd, "pic.png", img)
    write_png(fppd, "still.png", still)
    with DdpReceiver(channels) as rx:
        fppd.start()
        assert model(fppd)["width"] == WIDTH and model(fppd)["height"] == HEIGHT
        want = place(still, 4, 1, bpp=4)
        image_effect(fppd, "still.png", "Center")
        wait_frame(fppd, rx, lambda f: f == want, "the centred image in RGBW")

        expected = [place(img, x, y, bpp=4) for x, y in scroll_positions(img, "Top to Bottom")]
        since = time.monotonic()
        image_effect(fppd, "pic.png", "Top to Bottom")
        effect_done(fppd, "M", timeout=20)
        # The centred image is on the wire until the scroll's first frame.
        check_scroll([f for _, f in rx.snapshot(since)], [want] + expected,
                     "Top to Bottom in RGBW")
        goes_dark(fppd, rx)
