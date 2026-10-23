"""Output processors (config/outputprocessors.json), checked on the wire.

A sequence holds one frame over and over; each processor's effect on it is
worked out here independently and compared with what reaches a DDP
receiver. Channel numbers in the config are 1-based, as the UI shows them.
"""

import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames
from show import CHANNELS, install, playlist, status


def ramp():
    """Channel i holds a value that names it; some channels are 0."""
    return bytes((i * 7) % 256 if i % 5 else 0 for i in range(CHANNELS))


def proc(type_, **kw):
    p = {"type": type_, "active": 1, "description": "test"}
    p.update(kw)
    return p


def write_processors(fppd, processors):
    fppd.write("config/outputprocessors.json", {"outputProcessors": processors})


def run(fppd, processors, frames=None, seconds=30):
    """Play `frames` (a static ramp by default) through `processors` and
    return the receiver once frames arrive."""
    frames = frames or [ramp()] * (seconds * 20)
    install(fppd, frames)
    write_processors(fppd, processors)
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    return frames


def latest(fppd, rx, predicate=lambda f: True, what="a frame", timeout=10):
    def check():
        f = rx.last()
        return f if f is not None and any(f) and predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def remap(src, dst, count, loops, reverse):
    def apply(d):
        d = bytearray(d)
        block = bytes(d[src - 1:src - 1 + count])
        if reverse == 1:
            block = block[::-1]
        elif reverse == 2:
            px = [block[i:i + 3] for i in range(0, count, 3)]
            block = b"".join(px[::-1])
        for l in range(loops):
            at = dst - 1 + l * count
            d[at:at + count] = block
        return bytes(d)
    return apply


def per_channel(start, count, fn):
    def apply(d):
        d = bytearray(d)
        for i in range(start - 1, start - 1 + count):
            d[i] = fn(d[i])
        return bytes(d)
    return apply


def reorder(start, pixels, order):
    def apply(d):
        d = bytearray(d)
        for p in range(pixels):
            at = start - 1 + p * 3
            rgb = d[at:at + 3]
            d[at:at + 3] = bytes(rgb[int(c) - 1] for c in str(order))
        return bytes(d)
    return apply


def three_to_four(start, pixels, algorithm, order):
    def apply(d):
        d = bytearray(d)
        src = [bytes(d[start - 1 + p * 3:start - 1 + p * 3 + 3]) for p in range(pixels)]
        for p, (r, g, b) in enumerate(src):
            w = 0
            if algorithm == 1 and r == g == b:
                w, r, g, b = r, 0, 0, 0
            out = bytes([w, r, g, b]) if order == 4123 else bytes([r, g, b, w])
            at = start - 1 + p * 4
            d[at:at + 4] = out
        return bytes(d)
    return apply


def fold(start, count, nodesize):
    def apply(d):
        d = bytearray(d)
        nodes = count // nodesize
        src = [bytes(d[start - 1 + n * nodesize:start - 1 + (n + 1) * nodesize]) for n in range(nodes)]
        for n, node in enumerate(src):
            pos = nodes - n // 2 - 1 if n % 2 else n // 2
            at = start - 1 + pos * nodesize
            d[at:at + nodesize] = node
        return bytes(d)
    return apply


CASES = {
    "Remap": ([proc("Remap", source=1, destination=31, count=6, loops=2, reverse=0)],
              remap(1, 31, 6, 2, 0)),
    "Remap reversed by channel": ([proc("Remap", source=4, destination=61, count=9, loops=1, reverse=1)],
                                  remap(4, 61, 9, 1, 1)),
    "Remap reversed by pixel": ([proc("Remap", source=4, destination=61, count=9, loops=1, reverse=2)],
                                remap(4, 61, 9, 1, 2)),
    "Brightness 50%": ([proc("Brightness", start=1, count=60, brightness=50, gamma=1.0)],
                       per_channel(1, 60, lambda v: int(127.5 * v / 255 + 0.5))),
    "Set Value": ([proc("Set Value", start=41, count=5, value=200)],
                  per_channel(41, 5, lambda v: 200)),
    "Clamp Value": ([proc("Clamp Value", start=1, count=CHANNELS, value=100)],
                    per_channel(1, CHANNELS, lambda v: min(v, 100))),
    "Scale Value": ([proc("Scale Value", start=1, count=30, scale=2.0)],
                    per_channel(1, 30, lambda v: min(255, int(2 * v + 0.5)))),
    "Override Zero": ([proc("Override Zero", start=1, count=30, value=9)],
                      per_channel(1, 30, lambda v: v or 9)),
    "Reorder Colors 321": ([proc("Reorder Colors", start=1, count=10, colorOrder=321)],
                           reorder(1, 10, 321)),
    "Reorder Colors 231": ([proc("Reorder Colors", start=31, count=5, colorOrder=231)],
                           reorder(31, 5, 231)),
    "Three to Four, no white": ([proc("Three to Four", start=1, count=5, colorOrder=1234, algorithm=0)],
                                three_to_four(1, 5, 0, 1234)),
    "Three to Four, WRGB": ([proc("Three to Four", start=1, count=5, colorOrder=4123, algorithm=0)],
                            three_to_four(1, 5, 0, 4123)),
    "Fold by channel": ([proc("Fold", source=1, count=12, node=0)], fold(1, 12, 1)),
    "Fold by RGB pixel": ([proc("Fold", source=31, count=18, node=1)], fold(31, 18, 3)),
    "a chain, in file order": ([proc("Set Value", start=1, count=6, value=40),
                                proc("Remap", source=1, destination=101, count=6, loops=1, reverse=0),
                                proc("Scale Value", start=101, count=6, scale=1.5)],
                               lambda d: per_channel(101, 6, lambda v: int(1.5 * v + 0.5))(
                                   remap(1, 101, 6, 1, 0)(per_channel(1, 6, lambda v: 40)(d)))),
}


@pytest.mark.parametrize("what", list(CASES))
def test_processor_output(fppd, what):
    """Each processor transforms the frame exactly as documented, and
    nowhere else.

    Regression: 476c9df96 (Fold by channel). The Fold copied three bytes a
    node whatever its node size, so a By Channel fold read past the end of
    its scratch copy: an ASan heap-buffer-overflow on the first frame."""
    processors, expect = CASES[what]
    with DdpReceiver(CHANNELS) as rx:
        frames = run(fppd, processors)
        want = expect(frames[0])
        got = latest(fppd, rx)
        time.sleep(0.3)
        got = rx.last()
        diff = [(i + 1, frames[0][i], want[i], got[i]) for i in range(CHANNELS) if want[i] != got[i]]
        assert not diff, f"{what}: channel (in, expected, got): {diff[:12]}"


def test_hold_value_holds_through_zeros(fppd):
    """Hold Value keeps each channel at its last non-zero value while the
    sequence drops it to zero."""
    lit = bytes([50] * 30) + bytes(CHANNELS - 30)
    dark = bytes(CHANNELS)
    frames = [lit if (i // 10) % 2 == 0 else dark for i in range(600)]
    with DdpReceiver(CHANNELS) as rx:
        run(fppd, [proc("Hold Value", start=1, count=15)], frames=frames)
        latest(fppd, rx, what="the lit frames")
        since = time.monotonic()
        time.sleep(2)  # four lit/dark cycles
        seen = {f[:30] for _, f in rx.snapshot(since)}
        assert all(f[:15] == bytes([50] * 15) for f in seen), "held channels went dark"
        assert any(not any(f[15:30]) for f in seen), "unheld channels never went dark"


def test_processors_reload_when_the_file_is_saved(fppd):
    """Saving outputprocessors.json while a sequence plays applies the new
    chain at once, without a restart (46d0e1a1f)."""
    with DdpReceiver(CHANNELS) as rx:
        frames = run(fppd, [proc("Set Value", start=1, count=3, value=11)])
        latest(fppd, rx, lambda f: f[:3] == b"\x0b\x0b\x0b", "the first chain")
        time.sleep(1.1)
        write_processors(fppd, [proc("Set Value", start=1, count=3, value=22)])
        latest(fppd, rx, lambda f: f[:3] == b"\x16\x16\x16", "the saved chain", timeout=15)
        write_processors(fppd, [])
        latest(fppd, rx, lambda f: f[:3] == frames[0][:3], "no processors", timeout=15)


@pytest.mark.parametrize("bad", [
    proc("Set Value", start=8388600, count=100, value=1),
    proc("Set Value", start=2000000000, count=100, value=1),
    proc("Remap", source=1, destination=2000000000, count=50, loops=1, reverse=0),
    proc("Remap", source=1, destination=8388600, count=50, loops=4, reverse=0),
    proc("Remap", source=-5, destination=1, count=10, loops=1, reverse=0),
    proc("Brightness", start=1, count=-10, brightness=50, gamma=1.0),
    proc("Fold", source=0, count=30, node=1),
    proc("Fold", source=1, count=30, node=7),
    proc("Three to Four", start=8388600, count=100, colorOrder=1234, algorithm=0),
    proc("Brightness", start=1, count=30),
    proc("No Such Processor", start=1, count=30),
    proc("Brightness", start=1, count=30, brightness=50, gamma="nan"),
    proc("Brightness", start="1", count="30", brightness="50", gamma="2.2"),
    proc("Set Value", start=[1], count={"a": 1}, value=None),
    proc("Remap", source="x", destination=31, count=6, loops=1e300, reverse="y"),
    proc("Set Value", start=2000000000, count=2000000000, value=1),
    proc("Reorder Colors", start=1, count=800000000, colorOrder=321),
    proc("Set Value", start=-20, count=5, value=1),
], ids=["set past the end", "set far past the end", "remap far past the end", "remap past the end", "remap negative source",
        "negative count", "fold source 0", "fold unknown node", "three-to-four past the end",
        "brightness with no values", "unknown type", "gamma nan", "numbers as strings",
        "values of the wrong type", "remap junk", "set range overflows an int",
        "reorder count overflows an int", "set entirely before channel 1"])
def test_bad_processor_is_refused_or_survived(fppd, bad):
    """A processor whose channels fall outside channel space, or with a bad
    or missing value, is refused (with a warning) or clamped -- never let
    write outside the channel buffer -- and the show plays on.

    Regressions: 8173f97c7 (processors reaching past the sequence buffer:
    the far cases and a negative source crash its parent; ones just past
    the end land in unchecked memory there), 0d9f83978 (values of the wrong
    JSON type terminated fppd at startup), and the Fold and Brightness
    checks from the same audit), and 7562208f2 (a start or count large
    enough to overflow the int the range is reported in looked like an
    empty range, was let through and wrote billions of channels; the
    overflow cases crash its parent)."""
    with DdpReceiver(CHANNELS) as rx:
        run(fppd, [bad, proc("Set Value", start=150, count=1, value=7)])
        latest(fppd, rx, lambda f: f[149] == 7, "the good processor after the bad one")
        time.sleep(1)
        assert status(fppd).get("status_name") == "playing"


def half(v):
    return int(127.5 * v / 255 + 0.5)


BRIGHTNESS_DEFAULTS = {
    "gamma blank": ({"brightness": 50, "gamma": None}, half,
                    "has no gamma value, using 1.0"),
    "gamma missing": ({"brightness": 100}, lambda v: v,
                      "has no gamma value, using 1.0"),
    "gamma 0": ({"brightness": 100, "gamma": 0}, lambda v: v,
                "has an invalid gamma (0.000000), using 1.0"),
    "brightness blank": ({"brightness": None, "gamma": 1.0}, lambda v: v,
                         "has no brightness value, using 100"),
    "brightness missing": ({"gamma": 1.0}, lambda v: v,
                           "has no brightness value, using 100"),
    "brightness over 100": ({"brightness": 150, "gamma": 1.0}, lambda v: v,
                            "has an invalid brightness (150), clamping"),
    "brightness below 0": ({"brightness": -20, "gamma": 1.0}, lambda v: 0,
                           "has an invalid brightness (-20), clamping"),
}


@pytest.mark.parametrize("what", list(BRIGHTNESS_DEFAULTS))
def test_brightness_with_a_blank_or_bad_value(fppd, what):
    """A Brightness processor with a blank (null) or missing brightness or
    gamma uses the UI's defaults, 100 and 1.0, and one out of range is
    clamped: dark channels stay dark, lit ones get the brightness asked
    for, and a warning names the processor.

    Regression: c595ea4a5. Both values were read unchecked, so a blank or
    missing one read as 0. A gamma of 0 made every entry of the table
    pow(x, 0) = 1 times the brightness, so dark channels lit up (at 100%
    with brightness 100); a brightness of 0 blacked the range out; 150
    scaled the range by 1.5. No warning was raised for any of them.
    """
    values, fn, message = BRIGHTNESS_DEFAULTS[what]
    p = proc("Brightness", start=1, count=60, description="Porch")
    p.update(values)
    with DdpReceiver(CHANNELS) as rx:
        frames = run(fppd, [p])
        want = per_channel(1, 60, fn)(frames[0])
        latest(fppd, rx)
        time.sleep(0.3)
        got = rx.last()
        diff = [(i + 1, frames[0][i], want[i], got[i]) for i in range(CHANNELS) if want[i] != got[i]]
        assert not diff, f"{what}: channel (in, expected, got): {diff[:12]}"
    expected = "Brightness output processor 'Porch' " + message
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert expected in warnings, f"no warning {expected!r}; warnings: {warnings}"


def test_reload_never_drops_the_chain(fppd):
    """A brightness limit stays on through reloads of outputprocessors.json:
    a file caught half-written keeps the running chain, and rewriting the
    file over and over never lets a frame out without it.

    Regression: d4011f0ee. A reload that failed to parse loaded an empty
    chain, and every reload removed the old processors before adding the
    new ones one at a time -- either way frames went out at full brightness.
    """
    full = [bytes([255] * CHANNELS)] * 1200
    limit = [proc("Brightness", start=1, count=CHANNELS, brightness=10, gamma=1.0)]
    with DdpReceiver(CHANNELS) as rx:
        run(fppd, limit, frames=full)
        latest(fppd, rx, lambda f: f[0] == 26, "the limited output")
        since = time.monotonic()
        import os
        path = os.path.join(fppd.media, "config", "outputprocessors.json")
        for i in range(40):
            with open(path, "w") as f:  # caught part way through a write
                f.write('{"outputProcessors": [{"type": "Brightness", "active": 1, ')
            time.sleep(0.05)
            write_processors(fppd, limit)
            time.sleep(0.05)
        time.sleep(1)
        over = [f[0] for _, f in rx.snapshot(since) if f[0] > 26]
        assert not over, f"{len(over)} frames went out without the brightness limit"


def test_playlist_remap_remove_then_saving_the_processors(fppd):
    """A playlist Remap entry with action "remove" that matches a Remap from
    the Output Processors page switches it off, and saving the Output
    Processors page afterwards loads the new chain without a double free.

    Regression: 42852d014. removeProcessor() (4f13d1049) deleted the
    processor it removed, but one loaded from outputprocessors.json was
    still on fromJsonProcessors (d4011f0ee), and the next loadFromJSON()
    deleted it again: an ASan double free.
    """
    with DdpReceiver(CHANNELS) as rx:
        frames = run(fppd, [proc("Remap", source=1, destination=31, count=6, loops=1, reverse=0)])
        latest(fppd, rx, lambda f: f[30:36] == frames[0][0:6], "the remap applied")
        fppd.write("playlists/Off.json", playlist("Off", [{
            "type": "remap", "enabled": 1, "playOnce": 0, "action": "remove",
            "source": 1, "destination": 31, "count": 6, "loops": 1, "reverse": 0}]))
        fppd.command("Start Playlist", "Off", "false", "false")
        time.sleep(2)
        time.sleep(1.1)  # a save in a later second, as a person makes it
        write_processors(fppd, [proc("Set Value", start=1, count=3, value=22)])
        fppd.command("Start Playlist", "Show", "false", "false")
        latest(fppd, rx, lambda f: f[:3] == b"\x16\x16\x16", "the saved chain", timeout=15)
