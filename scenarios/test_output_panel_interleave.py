"""LED panel interleave maps, built with the tree's own
PanelInterleaveHandler (tools/interleavecheck.cpp) rather than through an
output: only the PRU panel drivers (BBBMatrix, BBShiftPanel) use it, and
those need a Beagle with a panel cape.
"""

import os
import subprocess
import tempfile

import pytest

from fppd import sanitizer

HERE = os.path.dirname(os.path.abspath(__file__))

# Every panel size and scan the LED Panels page offers.
UI_SIZES = sorted({(32, 16, 8), (32, 16, 4), (32, 16, 2), (32, 32, 16), (32, 32, 8),
                   (64, 32, 16), (64, 32, 8), (64, 64, 8), (64, 64, 16), (64, 64, 32),
                   (64, 64, 64), (128, 64, 16), (128, 64, 32), (128, 64, 64), (40, 20, 5),
                   (80, 40, 10), (80, 40, 20), (48, 48, 6)})
FLIP_TYPES = ["1f", "2f", "4f", "8f", "16f", "32f", "40f", "64f", "80f"]

_tool = None


def tool():
    """tools/interleavecheck.cpp built against the tree under test (with its
    sanitizer, so an overrun in the handler is reported), once per run."""
    global _tool
    if _tool is None:
        src = os.path.join(os.environ["FPP_TREE"], "src")
        out = os.path.join(tempfile.mkdtemp(prefix="interleavecheck-"), "interleavecheck")
        flags = {"asan": ["-fsanitize=address"], "tsan": ["-fsanitize=thread"],
                 "ubsan": ["-fsanitize=undefined"]}.get(sanitizer(), [])
        cmd = ["g++", "-std=gnu++20", "-g", "-O1", *flags, f"-I{src}",
               os.path.join(HERE, "..", "tools", "interleavecheck.cpp"),
               os.path.join(src, "channeloutput", "PanelInterleaveHandler.cpp"), "-o", out]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("building interleavecheck failed:\n" + r.stderr[-4000:])
        _tool = out
    return _tool


def handler_map(type_, w, h, scan, timeout=10):
    """None if the handler is refused, else {(x, y): (x', y')}."""
    env = dict(os.environ, ASAN_OPTIONS="halt_on_error=1:detect_leaks=0")
    r = subprocess.run([tool(), type_, str(w), str(h), str(scan)], capture_output=True,
                       text=True, timeout=timeout, env=env)
    assert r.returncode == 0, f"{type_} {w}x{h} 1/{scan}: exit {r.returncode}\n{r.stderr[-3000:]}"
    if r.stdout.strip() == "null":
        return None
    out = {}
    for line in r.stdout.splitlines():
        a, b = line.split(" -> ")
        out[tuple(map(int, a.split()))] = tuple(map(int, b.split()))
    return out


@pytest.mark.parametrize("type_", FLIP_TYPES)
def test_flip_rows_interleaves_map_every_pixel_once(type_):
    """Every Flip Rows interleave, at every panel size and scan the UI
    offers, is refused or maps the panel one to one.

    Regression: 0e1926de8. The block swap was "y &= !scan", a logical not
    that zeroed y, so on panels with more than two scan blocks (32x16 1/2,
    64x64 1/8, 48x48 1/6 ...) distinct rows mapped to the same place.
    """
    bad = []
    for w, h, scan in UI_SIZES:
        m = handler_map(type_, w, h, scan)
        if m is not None and len(set(m.values())) != len(m):
            bad.append(f"{w}x{h} 1/{scan}: {len(m) - len(set(m.values()))} pixels share a place")
    assert not bad, f"{type_}: " + "; ".join(bad)


def test_40f_is_40_with_its_scan_blocks_swapped():
    """"40f" on an 80x40 1/10 panel is the "40" interleave with each pair
    of scan blocks swapped.

    Regression: 0e1926de8. "40f" built a 32-pixel interleave.
    """
    w, h, scan = 80, 40, 10
    plain = handler_map("40", w, h, scan)
    flip = handler_map("40f", w, h, scan)
    assert plain is not None and flip is not None, "40/40f refused on an 80x40 1/10 panel"
    swapped = {(x, y): plain[(x, (y // scan ^ 1) * scan + y % scan)] for (x, y) in plain}
    diff = [k for k in flip if flip[k] != swapped[k]]
    assert not diff, f"{len(diff)} pixels differ, first {diff[0]}: {flip[diff[0]]} != {swapped[diff[0]]}"


@pytest.mark.parametrize("type_, w, h, scan", [
    ("8", 32, 16, 0), ("8f", 32, 16, 0),
], ids=["scan 0", "scan 0 with flipped rows"])
def test_bad_panel_geometry_is_refused(type_, w, h, scan):
    """An interleave asked for a panel geometry no handler can map (a scan of
    0 or below) comes back quickly, refused.

    Regression: 35e11a408. A scan of 0 looped forever in mapRow(), hanging
    the config load on the main loop.
    """
    try:
        handler_map(type_, w, h, scan, timeout=5)
    except subprocess.TimeoutExpired:
        pytest.fail(f"{type_} {w}x{h} 1/{scan}: createHandler() never returned")


def test_doublez_interleave_maps_every_pixel_once():
    """The DoubleZ interleave ("RPi21" on a Pi, as the LED Panels page saves
    it) is refused or maps the panel one to one at every size and scan the
    UI offers. On a 32x16 1/4 panel each 8-column block of the scanned
    half becomes 16 columns of 4 rows: its rows 4-7 in the first 8 columns
    and its rows 0-3 in the next 8, both left to right.

    Regression: 1686dd7f1 added the interleave. Before it there was no
    21st Pi mapper: "RPi21" left the mapper unset and the handler
    dereferenced it, a SIGSEGV building the handler.
    """
    bad = []
    mapped = 0
    for w, h, scan in UI_SIZES:
        m = handler_map("RPi21", w, h, scan)
        if m is None:
            continue
        mapped += 1
        if len(set(m.values())) != len(m):
            bad.append(f"{w}x{h} 1/{scan}: {len(m) - len(set(m.values()))} pixels share a place")
    assert not bad, "; ".join(bad)
    assert mapped, "DoubleZ was refused at every size"

    m = handler_map("RPi21", 32, 16, 4)
    want = {(x, y): (16 * (x // 8) + (8 if y < 4 else 0) + x % 8, y % 4)
            for y in range(8) for x in range(32)}
    diff = [k for k in want if m.get(k) != want[k]]
    assert not diff, f"{len(diff)} pixels misplaced, first {diff[0]}: {m.get(diff[0])} != {want[diff[0]]}"


@pytest.mark.parametrize("w, h, scan", [(64, 64, 16), (64, 32, 8)], ids=["64x64 1/16", "64x32 1/8"])
def test_no_interleave_is_refused_on_a_panel_that_folds_its_rows(w, h, scan):
    """Interleave "Off" on a panel that scans fewer rows than half its
    height -- a 64x64 1/16, a 64x32 1/8 -- is refused; on a 64x32 1/16,
    where nothing folds, it is the identity.

    Regression: 53585566e. Any type createHandler() didn't know, "Off"
    included, fell back to the identity map, whose rows run to half the
    panel height while the PRU drivers' frame holds only `scan` rows:
    BBBMatrix::PrepData wrote about twice its allocation on the first
    frame."""
    assert handler_map("Off", w, h, scan) is None, f"Off accepted for a {w}x{h} 1/{scan} panel"
    m = handler_map("Off", 64, 32, 16)
    assert m is not None and all(m[k] == k for k in m), "Off is not the identity on a 64x32 1/16 panel"


def test_every_accepted_interleave_maps_inside_the_frame():
    """Every interleave the LED Panels page offers, at every size and scan
    it offers, is either refused or maps the half panel inside the frame
    the drivers size for it: `scan` rows of width * height / (scan * 2)
    columns.

    Regression: 53585566e (the check where the handler is built)."""
    types = ["Off", "4", "8", "16", "32", "40", "64", "80", "4z", "8z", "16z", "8c", "8s", *FLIP_TYPES,
             *[f"RPi{n}" for n in range(1, 22)]]
    bad = []
    for t in types:
        for w, h, scan in UI_SIZES:
            m = handler_map(t, w, h, scan)
            if m is None:
                continue
            span = w * h // (scan * 2)
            out = [k for k, (x, y) in m.items() if not (0 <= y < scan and 0 <= x < span)]
            if out:
                bad.append(f"{t} {w}x{h} 1/{scan}: {len(out)} pixels outside, e.g. {out[0]} -> {m[out[0]]}")
    assert not bad, "; ".join(bad[:8]) + (f" ... ({len(bad)} in all)" if len(bad) > 8 else "")


@pytest.mark.parametrize("type_, w, h, scan", [
    ("32z", 64, 32, 8), ("32z", 64, 64, 16), ("40z", 80, 40, 10),
], ids=["32z 64x32 1/8", "32z 64x64 1/16", "40z 80x40 1/10"])
def test_32_and_40_pixel_zig_zag_interleaves_are_built(type_, w, h, scan):
    """The 32 and 40 pixel Zig/Zag interleaves the LED Panels page offers on
    a BeagleBone ("32z", "40z") build a handler on a panel that folds its
    rows, and it maps the panel one to one.

    Regression: da338f477 added them. Before it neither driver knew the
    names: the matrix fell back to no interleave, which on a folding panel
    is now refused outright (53585566e) -- the output does not start.
    """
    m = handler_map(type_, w, h, scan)
    assert m is not None, f"{type_} refused on a {w}x{h} 1/{scan} panel"
    assert len(set(m.values())) == len(m) == w * h // 2, \
        f"{len(m)} pixels, {len(m) - len(set(m.values()))} share a place"
