"""The Text overlay effect's colour modes (ColorMode, Palette, NumColors,
Color2-5, ColorSpeed): gradients, per-letter/word/line palettes, the random
modes, and the animated Sparkle and Chase, still and scrolling.

Every colour mode draws the text white and paints that coverage mask, so a
Single white render of the same text is the mask itself. The still modes are
checked pixel for pixel against it: a gradient's colour at each pixel is
known from where the pixel sits in the ink, scaled by its coverage.

Feature: a49b990df (TextColorizer, the colour modes).
"""

import time
import urllib.request

import pytest

from fppd import API
from test_overlays import effect_done, matrix, setup, stop_effects

W, H = 64, 24
RED, GREEN, BLUE, WHITE = (255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255)

# TextColorizer.cpp's named palettes, as the UI offers them.
PALETTES = {
    "Christmas": [0xFF0000, 0x00FF00, 0xFFFFFF],
    "Halloween": [0xFF6000, 0x8000FF, 0x00FF00],
    "Winter": [0xFFFFFF, 0x80D0FF, 0x0040FF],
    "Fire": [0xFF0000, 0xFF6000, 0xFFC000, 0xFFFF80],
    "Ocean": [0x0020FF, 0x00A0FF, 0x00FFC0],
    "Forest": [0x004000, 0x00A000, 0x80FF00],
    "Patriotic": [0xFF0000, 0xFFFFFF, 0x0000FF],
    "Pastel": [0xFFB0C0, 0xB0E0FF, 0xFFF0A0, 0xB0FFC0],
    "Party": [0xFF00A0, 0x00FFFF, 0xFFFF00, 0x80FF00, 0xFF4000],
}


def rgb(c):
    return ((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF)


def hexc(c):
    return "#%02X%02X%02X" % c


def start(fppd, width=W, height=H):
    setup(fppd, [matrix("M", width=width, height=height)], channels=width * height * 3)
    fppd.start()
    # Enabled up front: a Text effect that has to auto-enable the model takes
    # a still message down again 25 ms later unless it is given a Duration.
    fppd.command("Overlay Model State", "M", "Enabled")
    fonts = fppd.get("/overlays/fonts")
    if not fonts:
        pytest.skip("no fonts installed")
    # A plain sans face, so letters stand apart; any font will do otherwise.
    return next((f for f in fonts if f.lower() in ("dejavusans", "dejavu-sans")), fonts[0])


def raw(width=W, height=H):
    """The model's pixels, as rows of (r, g, b)."""
    with urllib.request.urlopen(f"{API}/overlays/model/M/data/raw", timeout=10) as r:
        data = r.read()
    assert len(data) >= width * height * 3, len(data)
    return [[tuple(data[(y * width + x) * 3:(y * width + x) * 3 + 3]) for x in range(width)]
            for y in range(height)]


def text(fppd, font, msg="HHHH", mode="Single", palette="Custom", colors=(RED, BLUE),
         speed=0, position="Center", scroll="10", size="14", duration="0", state="Enabled"):
    """Apply the Text effect with `colors[0]` as Color and the rest as
    Color2.. (NumColors is their count)."""
    extra = {f"Color{i + 2}": hexc(c) if isinstance(c, tuple) else c
             for i, c in enumerate(colors[1:])}
    desc = fppd.get("/overlays/effects/Text")
    over = dict(Color=hexc(colors[0]), Font=font, FontSize=size, FontAntiAlias="false",
                Position=position, Speed=scroll, Duration=duration, Text=msg, ColorMode=mode,
                Palette=palette, NumColors=str(len(colors)), ColorSpeed=str(speed), **extra)
    names = [a["name"] for a in desc["args"]]
    missing = [k for k in over if k not in names]
    if missing:
        pytest.skip(f"the Text effect has no {missing} arguments in this tree")
    args = [over.get(n, a.get("default", "")) for n, a in zip(names, desc["args"])]
    fppd.command("Overlay Model Effect", "M", state, "Text", *args)


def settled(fppd, what, width=W, height=H):
    """The model's pixels once they are lit and have stopped changing."""
    last = [None]

    def same():
        f = raw(width, height)
        ok = f == last[0] and any(any(p) for row in f for p in row)
        last[0] = f
        return ok
    fppd.wait_for(same, timeout=10, interval=0.1, what=what)
    return last[0]


def coverage(fppd, font, msg="HHHH", **kw):
    """The text's coverage mask: a Single render in white."""
    text(fppd, font, msg, colors=(WHITE,), **kw)
    f = settled(fppd, "the white render")
    mask = [[max(p) for p in row] for row in f]
    assert any(any(r) for r in mask), "the white render drew nothing"
    return mask


def ink_box(mask):
    pts = [(x, y) for y, row in enumerate(mask) for x, v in enumerate(row) if v]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def lerp(a, b, f):
    f = min(max(f, 0.0), 1.0)
    return tuple(int(a[i] + (b[i] - a[i]) * f + 0.5) for i in range(3))


def ramp(colors, t):
    """A still (non-cyclic) palette ramp: first colour at 0, last at 1."""
    if len(colors) == 1:
        return colors[0]
    pos = min(max(t, 0.0), 1.0) * (len(colors) - 1)
    i = int(pos)
    if i >= len(colors) - 1:
        return colors[-1]
    return lerp(colors[i], colors[i + 1], pos - i)


def hue(h):
    h = (h - int(h)) * 6.0
    s, f = int(h), h - int(h)
    q, t = int(255 * (1 - f) + 0.5), int(255 * f + 0.5)
    return [(255, t, 0), (q, 255, 0), (0, 255, t), (0, q, 255), (t, 0, 255), (255, 0, q)][s]


def scaled(c, cov):
    return tuple(v * cov // 255 for v in c)


def mismatches(frame, mask, expect):
    """Pixels more than 1 off the colour `expect(x, y)` scaled by coverage."""
    bad = []
    for y, row in enumerate(mask):
        for x, cov in enumerate(row):
            want = scaled(expect(x, y), cov) if cov else (0, 0, 0)
            got = frame[y][x]
            if any(abs(got[i] - want[i]) > 1 for i in range(3)):
                bad.append(((x, y), got, want))
    return bad


def column_colors(frame, mask):
    """The colour of each lit column, at its fully covered pixels, collapsed
    to the order the colours appear in from left to right. A column painted
    in more than one colour is reported as such."""
    seq, mixed = [], []
    for x in range(len(mask[0])):
        cs = {frame[y][x] for y in range(len(mask)) if mask[y][x] == 255}
        if not cs:
            continue
        if len(cs) > 1:
            mixed.append((x, cs))
            continue
        c = cs.pop()
        if not seq or seq[-1] != c:
            seq.append(c)
    return seq, mixed


def lit(frame):
    return {(x, y) for y, row in enumerate(frame) for x, p in enumerate(row) if any(p)}


def test_still_gradients_follow_the_ink(fppd):
    """Gradient Horizontal, Vertical and Diagonal with ColorSpeed 0 run from
    Color at one edge of the ink to Color2 at the other, every pixel the
    blend for where it sits, at its coverage."""
    font = start(fppd)
    mask = coverage(fppd, font)
    x0, y0, x1, y1 = ink_box(mask)
    assert x1 - x0 > 20 and y1 - y0 > 5, f"text too small to grade: {(x0, y0, x1, y1)}"
    tx = lambda x: (x - x0) / (x1 - x0)
    ty = lambda y: (y - y0) / (y1 - y0)
    for mode, at in (("Gradient Horizontal", lambda x, y: tx(x)),
                     ("Gradient Vertical", lambda x, y: ty(y)),
                     ("Gradient Diagonal", lambda x, y: (tx(x) + ty(y)) / 2)):
        text(fppd, font, mode=mode)
        f = settled(fppd, f"the {mode} render")
        bad = mismatches(f, mask, lambda x, y: lerp(RED, BLUE, at(x, y)))
        assert not bad, f"{mode}: {len(bad)} pixels off, e.g. {bad[:5]}"


def test_custom_palette_colours_and_count(fppd):
    """NumColors picks how many of Color, Color2.. a Custom palette uses, and
    a colour that does not parse falls back to that slot's default rather
    than black."""
    font = start(fppd)
    mask = coverage(fppd, font)
    x0, _, x1, _ = ink_box(mask)
    tx = lambda x: (x - x0) / (x1 - x0)
    three = (RED, GREEN, BLUE)
    text(fppd, font, mode="Gradient Horizontal", colors=three)
    bad = mismatches(settled(fppd, "a three-colour gradient"), mask,
                     lambda x, y: ramp(list(three), tx(x)))
    assert not bad, f"three colours: {len(bad)} pixels off, e.g. {bad[:5]}"

    text(fppd, font, mode="Gradient Horizontal", colors=(GREEN,))
    bad = mismatches(settled(fppd, "a one-colour gradient"), mask, lambda x, y: GREEN)
    assert not bad, f"NumColors 1: {len(bad)} pixels off, e.g. {bad[:5]}"

    # Color2's default is #0000FF.
    text(fppd, font, mode="Gradient Horizontal", colors=(RED, "not-a-colour"))
    bad = mismatches(settled(fppd, "a gradient with a bad Color2"), mask,
                     lambda x, y: lerp(RED, BLUE, tx(x)))
    assert not bad, f"bad Color2: {len(bad)} pixels off, e.g. {bad[:5]}"


def test_named_palettes(fppd):
    """Each named palette, and Rainbow, is the colour set it is named for,
    whatever the Custom colours say."""
    font = start(fppd)
    mask = coverage(fppd, font)
    x0, _, x1, _ = ink_box(mask)
    tx = lambda x: (x - x0) / (x1 - x0)
    for name, cols in PALETTES.items():
        text(fppd, font, mode="Gradient Horizontal", palette=name, colors=(GREEN, GREEN))
        bad = mismatches(settled(fppd, f"the {name} gradient"), mask,
                         lambda x, y: ramp([rgb(c) for c in cols], tx(x)))
        assert not bad, f"{name}: {len(bad)} pixels off, e.g. {bad[:5]}"
    text(fppd, font, mode="Gradient Horizontal", palette="Rainbow")
    bad = mismatches(settled(fppd, "the Rainbow gradient"), mask,
                     lambda x, y: hue(min(max(tx(x), 0.0), 1.0)))
    assert not bad, f"Rainbow: {len(bad)} pixels off, e.g. {bad[:5]}"


def test_per_letter_and_per_word(fppd):
    """Per Letter steps through the palette one letter at a time, Per Word
    one word at a time, each letter or word in a single colour."""
    font = start(fppd)
    mask = coverage(fppd, font, "HHHH")
    text(fppd, font, "HHHH", mode="Per Letter", colors=(RED, BLUE))
    seq, mixed = column_colors(settled(fppd, "the Per Letter render"), mask)
    assert not mixed, f"Per Letter painted columns in two colours: {mixed[:5]}"
    assert seq == [RED, BLUE, RED, BLUE], f"Per Letter colours left to right: {seq}"

    msg = "HH HH HH"
    mask = coverage(fppd, font, msg, size="10")
    text(fppd, font, msg, mode="Per Word", colors=(RED, GREEN, BLUE), size="10")
    seq, mixed = column_colors(settled(fppd, "the Per Word render"), mask)
    assert not mixed, f"Per Word painted columns in two colours: {mixed[:5]}"
    assert seq == [RED, GREEN, BLUE], f"Per Word colours left to right: {seq}"


def test_per_line(fppd):
    """Per Line gives each line of a two-line message its own colour (a
    "\\n" typed into the text is a line break)."""
    font = start(fppd, height=32)
    msg = "HH\\nHH"
    text(fppd, font, msg, colors=(WHITE,), size="10")
    mask = [[max(p) for p in row] for row in settled(fppd, "the white render", height=32)]
    rows = [y for y, r in enumerate(mask) if any(r)]
    gap = next((y for y in range(rows[0], rows[-1]) if not any(mask[y])), None)
    assert gap is not None, "the two lines touch; no blank row between them"
    text(fppd, font, msg, mode="Per Line", colors=(RED, BLUE), size="10")
    f = settled(fppd, "the Per Line render", height=32)
    bad = mismatches(f, mask, lambda x, y: RED if y < gap else BLUE)
    assert not bad, f"Per Line: {len(bad)} pixels off, e.g. {bad[:5]}"


def test_random_letters_and_words_hold_still(fppd):
    """Random Letter and Random Word paint each letter or word one colour from
    the palette, and with ColorSpeed 0 the shuffle holds while the text is up
    instead of re-rolling."""
    font = start(fppd)
    palette = (RED, GREEN, BLUE, (255, 255, 0), (255, 0, 255))
    for msg, mode, size in (("HHHHHH", "Random Letter", "10"), ("H H H H", "Random Word", "10")):
        mask = coverage(fppd, font, msg, size=size)
        text(fppd, font, msg, mode=mode, colors=palette, size=size)
        first = settled(fppd, f"the {mode} render")
        seq, mixed = column_colors(first, mask)
        assert not mixed, f"{mode} painted columns in two colours: {mixed[:5]}"
        assert seq and set(seq) <= set(palette), f"{mode}: colours outside the palette: {seq}"
        time.sleep(1)
        assert raw() == first, f"{mode} with ColorSpeed 0 changed while it was up"


def test_animated_still_text_repaints_in_place(fppd):
    """Chase and Sparkle with a ColorSpeed animate centred text: the colours
    keep changing while the glyphs stay exactly where they are. Sparkle's
    flecks are white, which neither palette colour is."""
    font = start(fppd)
    mask = coverage(fppd, font)
    shape = {(x, y) for y, r in enumerate(mask) for x, v in enumerate(r) if v}
    for mode in ("Chase", "Sparkle"):
        text(fppd, font, mode=mode, colors=(RED, BLUE), speed=40)
        frames = []
        for _ in range(12):
            time.sleep(0.15)
            frames.append(raw())
        assert len({tuple(map(tuple, f)) for f in frames}) > 3, f"{mode} did not animate"
        for f in frames:
            assert lit(f) <= shape, f"{mode} lit pixels outside the text"
        if mode == "Sparkle":
            assert any(f[y][x] == WHITE for f in frames for (x, y) in shape), \
                "Sparkle never flecked a pixel white"
        assert any(m.get("effectRunning") for m in fppd.get("/overlays/models")
                   if m.get("Name") == "M"), f"{mode}: no effect running on the model"


def test_still_text_replaces_an_animated_one(fppd):
    """A still Single message applied over an animated colour mode stays as
    drawn: the animation is retired first, not left repainting over it."""
    font = start(fppd)
    text(fppd, font, mode="Chase", colors=(RED, BLUE), speed=60)
    time.sleep(0.5)
    text(fppd, font, "II", colors=(GREEN,))
    time.sleep(0.3)
    a = raw()
    time.sleep(0.6)
    b = raw()
    assert a == b, "the model kept changing after a still message replaced the animation"
    colours = {p for row in b for p in row if any(p)}
    assert colours and all(p[0] == 0 and p[2] == 0 for p in colours), \
        f"the still green text was painted over: {sorted(colours)[:8]}"


def test_animated_text_with_a_duration_ends_and_disables(fppd):
    """An animated centred message that auto-enabled a disabled model stops
    after its Duration, blanks the model and disables it again."""
    font = start(fppd)
    fppd.command("Overlay Model State", "M", "Disabled")
    text(fppd, font, mode="Chase", colors=(RED, BLUE), speed=40, duration="1")
    fppd.wait_for(lambda: fppd.get("/overlays/model/M").get("isActive"), timeout=5,
                  what="the effect to enable the model")
    fppd.wait_for(lambda: not fppd.get("/overlays/model/M").get("isActive"), timeout=10,
                  what="the model to be disabled after its Duration")
    assert not lit(raw()), "the model was left lit after the effect ended"


def test_scrolling_text_in_colour(fppd):
    """Scrolling text through a colour mode: still and animated gradients
    and a still Per Letter. Red to blue never has any green in it, so a
    pixel with green is paint from somewhere else."""
    font = start(fppd)
    for mode, speed in (("Gradient Horizontal", 50), ("Per Letter", 0), ("Gradient Vertical", 0)):
        # A new scroll takes over a running one where it has got to, so each
        # mode starts from a stopped model to scroll in from the edge.
        stop_effects(fppd, "M")
        effect_done(fppd, "M")
        fppd.command("Overlay Model State", "M", "Enabled")
        text(fppd, font, "HELLO WORLD", mode=mode, colors=(RED, BLUE), speed=speed,
             position="Right to Left", scroll="60")
        seen, frames = set(), 0
        for _ in range(20):
            time.sleep(0.1)
            f = raw()
            if lit(f):
                frames += 1
            seen |= {p for row in f for p in row if any(p)}
        assert frames >= 10, f"{mode}: the scrolling text was not drawn"
        green = [p for p in seen if p[1]]
        assert not green, f"{mode}: colours outside red-to-blue: {green[:8]}"
        assert any(p[0] > p[2] for p in seen) and any(p[2] > p[0] for p in seen), \
            f"{mode}: the scroll did not show both ends of the palette"
