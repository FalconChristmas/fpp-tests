"""Overlay geometry: the polar (Radial / Angular) buffer mappings WLED
effects draw through, built from the xLights layout in
config/virtualdisplaymap, and the xLights grid and channel-grid submodels
(config/xlights-submodels.json and xlights-modelgroups.json), checked node by
node on the wire.

The observable for the mappings is WLED's Percent effect: at "% of fill" p
it lights the first round(n * p / 100) of the n indices the buffer mapping
lays out, in Color 1 (the "* Color 1" palette), and paints the rest Color 2
(black here). So which nodes light says which nodes the mapping put first.
Before each run the model is filled with a dim grey, so a node the effect
never paints shows as grey rather than passing for one painted black.

Known fpp bug, left out of the assertions: a WLED segment one cell wide and
several high is not 2D to WLED, and its length is its width, 1. So Angular
CW/CCW on a single ring (polar buffer 1 x S), Vertical on a one-row model
and Horizontal on a one-column model paint one pixel and leave the rest
alone (WS2812FXExt's constructor, src/overlays/wled/wled.cpp)."""

import math
import os
import time

import pytest

from ddp import DdpReceiver
from fseq import solid_frames
from show import install
from test_overlays import fill, matrix, put, setup, submodel

LIT = (0, 0, 200)
PRIMER = (9, 9, 9)


def layout(fppd, points, mtime=None):
    """Write config/virtualdisplaymap as xLights' FPP Connect does: a "W,H"
    header, then one line per node, x,y,z,channel,channelCount,colorOrder,
    with the 0-based absolute channel. `points` maps channel -> (x, y)."""
    lines = ["400,400"]
    for ch, (x, y) in points.items():
        lines.append(f"{x},{y},0,{ch},3,RGB")
    path = fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def on_circle(r, degrees, centre=(100, 100)):
    """Integer screen coordinates, as the layout stores them."""
    a = math.radians(degrees)
    return (round(centre[0] + r * math.cos(a)), round(centre[1] + r * math.sin(a)))


def lit_nodes(frame, nodes, first=0):
    """{node: colour} for the nodes of `nodes` (3 channels each from 0-based
    channel `first`) that are not black."""
    out = {}
    for n in range(nodes):
        rgb = tuple(frame[first + 3 * n:first + 3 * n + 3])
        if any(rgb):
            out[n] = rgb
    return out


def wait_nodes(fppd, rx, nodes, want, what, first=0, timeout=10):
    """Wait for the wire to show exactly `want` ({node: colour}, every other
    node black), then check it still does a few frames later."""
    seen = {}

    def ok():
        f = rx.last()
        if f is None:
            return False
        seen["got"] = lit_nodes(f, nodes, first)
        return seen["got"] == want
    deadline = time.monotonic() + timeout
    while not ok():
        fppd.check_alive()
        if time.monotonic() > deadline:
            got = seen.get("got", {})
            raise AssertionError(f"{what}: wanted {sorted(want)} lit, got {sorted(got)} "
                                 f"in {sorted(set(got.values()))}")
        time.sleep(0.05)
    time.sleep(0.3)
    assert ok(), f"{what}: it changed afterwards to {sorted(seen['got'].items())}"


def percent(fppd, model, mapping, pct, state="Enabled"):
    """WLED - Percent on `model` through `mapping`, lighting pct% of it LIT
    and the rest black, at brightness 128 (unscaled)."""
    args = {"BufferMapping": mapping, "brightness": "128", "% of fill": str(pct),
            "One color": "0", "palette": "* Color 1",
            "color1": "#%02X%02X%02X" % LIT, "color2": "#000000"}
    desc = fppd.get("/overlays/effects/WLED%20-%20Percent")
    names = [a["name"] for a in desc["args"]]
    assert set(args) <= set(names), f"Percent's arguments are now {names}"
    values = [args.get(n, a.get("default", "")) for n, a in zip(names, desc["args"])]
    fppd.command("Overlay Model Effect", model, state, "WLED - Percent", *values)


def percent_lights(fppd, rx, model, mapping, pct, expected, nodes, what, first=0, painted=None):
    """Prime `model` grey, run Percent through `mapping`, and check that
    exactly the wire nodes `expected` light (in LIT) and every other node is
    black. `painted` is the wire nodes the model covers (default all
    `nodes`)."""
    painted = set(range(nodes)) if painted is None else set(painted)
    assert expected and set(expected) < painted, "a check that can't tell"
    fill(fppd, model, PRIMER)
    wait_nodes(fppd, rx, nodes, {n: PRIMER for n in painted}, f"{model} primed", first)
    percent(fppd, model, mapping, pct)
    wait_nodes(fppd, rx, nodes, {n: LIT for n in expected}, what, first)


# --- Three rings --------------------------------------------------------------
#
# 24 nodes laid out as three concentric rings, radius 10, 20 and 30 around a
# centre, eight pixels each at 45-degree steps. The wiring order is scrambled
# against the geometry: node c is on ring c % 3, at bearing (c // 3) * 3 % 8
# eighths of a turn, so no two mappings light the same nodes.
#
# By the code (PolarBufferMap.cpp): the centroid is the centre exactly (the
# rounded points are symmetric about it). The radii are 10 and 9.90 (on the
# diagonals, (7,7)), 20 and 19.80, 30 and 29.70: a spread of 2.0 times the
# mean, far from flat. Gaps over 2% of the 20.1 span (0.40) split them into
# exactly three rings of eight, overdraw 1, so the gap rings stand. Every
# bearing is an exact multiple of 45 degrees, so sector = bearing / 45.
# Radial is 8 sectors wide and 3 rings high, index = ring * 8 + sector;
# Angular is 3 wide and 8 high, index = sector * 3 + ring.

RINGS = 24
RADII = (10, 20, 30)


def ring_of(c):
    return c % 3


def sector_of(c):
    return (c // 3) * 3 % 8


def three_rings(ring=ring_of, channel=lambda c: 3 * c, centre=(100, 100)):
    """Layout points for the 24 ring nodes: channel(c) -> position."""
    return {channel(c): on_circle(RADII[ring(c)], sector_of(c) * 45, centre)
            for c in range(RINGS)}


def test_polar_mappings_light_rings_and_spokes_not_wiring_order(fppd):
    """On three concentric rings wired in a scrambled order, Percent lights:
      - Horizontal 34% (8 of 24): nodes 0-7, the wiring order, layout or not;
      - Radial Out 34%: exactly the inner ring's eight nodes;
      - Radial In 34%: exactly the outer ring's;
      - Angular CW 25% (6 of 24): the spokes at 0 and 45 degrees, all three
        rings of each;
      - Angular CCW 25%: the spokes at 315 and 270 degrees.
    The layout also holds positions for channels no model uses, which the
    join ignores.

    Feature: b4b022d17."""
    channels = RINGS * 3
    setup(fppd, [matrix("Rings", width=RINGS, height=1)], channels=channels)
    pts = three_rings()
    pts.update({1000 + 3 * i: (5 * i, 5) for i in range(10)})  # someone else's pixels
    layout(fppd, pts)
    every = range(RINGS)
    cases = [
        ("Horizontal", 34, set(range(8))),
        ("Radial Out", 34, {c for c in every if ring_of(c) == 0}),
        ("Radial In", 34, {c for c in every if ring_of(c) == 2}),
        ("Angular CW", 25, {c for c in every if sector_of(c) in (0, 1)}),
        ("Angular CCW", 25, {c for c in every if sector_of(c) in (7, 6)}),
    ]
    assert len({frozenset(e) for _, _, e in cases}) == len(cases)
    with DdpReceiver(channels) as rx:
        fppd.start()
        for mapping, pct, expected in cases:
            percent_lights(fppd, rx, "Rings", mapping, pct, expected, RINGS, f"{mapping} {pct}%")


def test_one_ring_is_one_radius_with_every_pixel_round_it(fppd):
    """A single ring (24 pixels at 15-degree steps, radius 30, wired in a
    scrambled order: node c at bearing 5c * 15 degrees) is one ring, not
    rings made out of the rounding of its integer coordinates (radii 29.7
    to 30.1, a spread under 0.15 of the mean): Radial Out 25% lights the six
    pixels from bearing 0 to 75 degrees, an arc, and Radial In the same arc
    (one ring reversed is itself). Split into rings by those radii, 25% would
    have lit four pixels at bearings 45, 135, 225 and 315 degrees.

    Angular CW/CCW on one ring are left out: that buffer is 1 x 24, and
    WLED draws only its first cell (the bug in the module docstring)."""
    n = 24
    setup(fppd, [matrix("Ring", width=n, height=1)], channels=n * 3)
    sector = {c: 5 * c % n for c in range(n)}
    pts = {3 * c: on_circle(30, sector[c] * 15) for c in range(n)}
    layout(fppd, pts)
    arc = {c for c in range(n) if sector[c] < 6}
    with DdpReceiver(n * 3) as rx:
        fppd.start()
        for mapping in ("Radial Out", "Radial In"):
            percent_lights(fppd, rx, "Ring", mapping, 25, arc, n, f"{mapping} on one ring")


def test_two_rings_are_split_by_population(fppd):
    """Two rings (12 pixels each, radius 5 and 25, on the integer points of
    those circles, so with no rounding) are too few for gap-detected rings
    (three at least), so the pixels are binned into equal-population rings:
    round(sqrt(24/2)) = 3 asked for, which with every radius 5 or 25 leaves
    the first empty, dropped, and the two real rings. Radial Out 50% lights
    the inner ring, Radial In 50% the outer. Node c is on the inner ring
    when c is even, at the (c // 2)th of the twelve bearings."""
    inner = [(5, 0), (4, 3), (3, 4), (0, 5), (-3, 4), (-4, 3),
             (-5, 0), (-4, -3), (-3, -4), (0, -5), (3, -4), (4, -3)]
    n = 24
    pts = {}
    for c in range(n):
        dx, dy = inner[c // 2]
        k = 1 if c % 2 == 0 else 5
        pts[3 * c] = (200 + k * dx, 200 + k * dy)
    setup(fppd, [matrix("Two", width=n, height=1)], channels=n * 3)
    layout(fppd, pts)
    with DdpReceiver(n * 3) as rx:
        fppd.start()
        percent_lights(fppd, rx, "Two", "Radial Out", 50, set(range(0, n, 2)), n,
                       "Radial Out on two rings")
        percent_lights(fppd, rx, "Two", "Radial In", 50, set(range(1, n, 2)), n,
                       "Radial In on two rings")


def test_a_new_layout_is_picked_up_by_the_next_effect(fppd):
    """The polar map is kept per model, mapping and layout file mtime. With
    the layout uploaded again (the rings permuted: node c moves to ring
    (c + 1) % 3) and its mtime moved on, the next Radial Out builds the map
    again and lights the new inner ring; with the first layout back (and
    a later mtime again), the first inner ring."""
    channels = RINGS * 3
    setup(fppd, [matrix("Rings", width=RINGS, height=1)], channels=channels)
    t0 = int(os.path.getmtime(layout(fppd, three_rings())))
    moved = lambda c: (c + 1) % 3  # noqa: E731
    with DdpReceiver(channels) as rx:
        fppd.start()
        percent_lights(fppd, rx, "Rings", "Radial Out", 34,
                       {c for c in range(RINGS) if ring_of(c) == 0}, RINGS,
                       "Radial Out on the first layout")
        layout(fppd, three_rings(ring=moved), mtime=t0 + 5)
        percent_lights(fppd, rx, "Rings", "Radial Out", 34,
                       {c for c in range(RINGS) if moved(c) == 0}, RINGS,
                       "Radial Out after the layout was uploaded again")
        layout(fppd, three_rings(), mtime=t0 + 10)
        percent_lights(fppd, rx, "Rings", "Radial Out", 34,
                       {c for c in range(RINGS) if ring_of(c) == 0}, RINGS,
                       "Radial Out with the first layout back")


def test_polar_mapping_without_the_geometry_behaves_as_horizontal(fppd):
    """Radial Out and Angular CCW on a model the layout can't place behave
    as Horizontal (34% lights nodes 0-7 in wiring order) when:
      - there is no config/virtualdisplaymap at all ("Plain");
      - the layout has only one of the model's nodes ("Lonely"), too few
        for any polar structure;
      - the layout has none of them, only other channels' ("Elsewhere").
    Each model is 24 nodes in a row, side by side on the wire. The layout
    (for Lonely and Elsewhere) is written after Plain has run, with a later
    mtime, so Plain's miss is not what they see; it holds three whole rings
    of other channels, so a join against the wrong channels would light
    rings."""
    n = 24
    models = [matrix("Plain", width=n, height=1),
              matrix("Lonely", start=1 + 3 * n, width=n, height=1),
              matrix("Elsewhere", start=1 + 6 * n, width=n, height=1)]
    channels = 9 * n
    setup(fppd, models, channels=channels)
    with DdpReceiver(channels) as rx:
        fppd.start()
        for mapping in ("Radial Out", "Angular CCW"):
            percent_lights(fppd, rx, "Plain", mapping, 34, set(range(8)), n,
                           f"{mapping} with no layout file")
        others = three_rings(channel=lambda c: channels + 3 * c)
        others[3 * n + 3 * 5] = (50, 50)  # Lonely's node 5, alone
        layout(fppd, others, mtime=int(time.time()) + 5)
        for name, first in (("Lonely", 3 * n), ("Elsewhere", 6 * n)):
            for mapping in ("Radial Out", "Angular CCW"):
                percent_lights(fppd, rx, name, mapping, 34, set(range(8)), n,
                               f"{mapping} on {name}", first=first)


def test_model_preview_numbers_points_by_node(fppd):
    """GET /overlays/model/<m>/preview lists the model's points in node
    order, each as [x, y, z, node], with the node number taken from the
    point's channel, however the layout file orders them.

    Regression: 7c6a64c98. xLights writes a model's points in spatial
    order, and the preview listed them in file order as [x, y, z]; the
    page took a point's position in the list as its node number, so a
    submodel's highlighted nodes landed on the wrong pixels.
    """
    setup(fppd, [matrix("M", start=31, width=4, height=1)])
    # Channels 30, 33, 36, 39 are nodes 1-4; written right to left.
    lines = ["400,400", "# Model: 'M'"]
    for node in (4, 2, 3, 1):
        lines.append(f"{node * 10},5,0,{30 + 3 * (node - 1)},3,RGB")
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    fppd.start()
    pixels = fppd.get("/overlays/model/M/preview")["pixels"]
    assert pixels == [[10, 5, 0, 1], [20, 5, 0, 2], [30, 5, 0, 3], [40, 5, 0, 4]], pixels


def test_a_large_model_preview_does_not_stall_its_effect(fppd):
    """Fetching the preview of a model with a very large layout doesn't
    freeze the effect running on it.

    Regression: 427c43e76. The preview parsed config/virtualdisplaymap,
    sorted it and built the reply under the model list's lock and the
    model's effect lock, so the effect thread (and the output thread, when
    the effect updates after output) waited out the whole parse: here
    about as long as the request took.
    """
    import threading
    from test_overlays import effect, wait_output
    width, height = 32, 16
    channels = width * height * 3
    setup(fppd, [matrix("M", width=width, height=height)], channels=channels)
    points = 300000
    lines = ["400,400", "# Model: 'M'"]
    lines += [f"{i % 400},{i // 400 % 400},0,{3 * (i % (width * height))},3,RGB" for i in range(points)]
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    with DdpReceiver(channels) as rx:
        fppd.start()
        effect(fppd, "M", "WLED - Rainbow")
        wait_output(fppd, rx, lambda f: any(f), "the effect to draw")
        took = []

        def preview():
            t = time.monotonic()
            fppd.get("/overlays/model/M/preview", timeout=60)
            took.append(time.monotonic() - t)
        since = time.monotonic()
        threads = [threading.Thread(target=preview) for _ in range(2)]
        for t in threads:
            t.start()
            t.join()
        frames = rx.snapshot(since)
    # The control: the parse is long enough that a stall behind it shows.
    assert min(took) > 0.5, f"the preview took only {took}"
    changes = [t for (t, f), (_, prev) in zip(frames[1:], frames) if f != prev]
    marks = [since] + changes + [frames[-1][0]]
    frozen = max(b - a for a, b in zip(marks, marks[1:]))
    assert frozen < 0.4, f"the effect froze for {frozen:.2f} s while the preview took {took}"


def test_polar_mapping_on_a_rectangle_submodel_joins_through_its_parent(fppd):
    """A rectangle submodel's cells are placed in the layout by the parent's
    channels they draw on. The parent is 26 x 2 nodes from channel 1; the
    submodel is its second row from x = 2, 24 cells, which land on parent
    nodes 28-51. Those nodes are three rings (cell i on ring i % 3); the
    parent's first row, nodes 0-23 -- channels 0-71, the submodel's own
    0-based data offsets -- is three rings elsewhere with cell i's
    counterpart on ring (i + 1) % 3. Radial Out 34% on the submodel lights
    exactly the cells of its inner ring, nodes 28 + i for i % 3 == 0, and
    nothing in the first row.

    Regression: 879ed0dfb. The join used the base model's startChannel +
    offset, and a submodel's startChannel is forced to 0, so it read the
    positions of channels 0-71 (the first row): the wrong ring lit.

    Known fpp bug, left out: the submodel's parent is looked up only when its
    state is set, and getPolarMap() remembers a failed build. A polar effect
    run with AutoEnable False on a submodel never enabled yet finds no
    parent, falls back to Horizontal, and every polar effect after that does
    too, enabled or not, until the layout's mtime changes."""
    w, h = 26, 2
    nodes = w * h
    sub_node = lambda i: w + 2 + i  # noqa: E731
    setup(fppd, [matrix("P", width=w, height=h), submodel("Row", "P", 2, 1, RINGS, 1)],
          channels=nodes * 3)
    pts = three_rings(channel=lambda c: 3 * sub_node(c))
    pts.update(three_rings(ring=lambda c: (c + 1) % 3, channel=lambda c: 3 * c,
                           centre=(300, 100)))
    layout(fppd, pts)
    expected = {sub_node(i) for i in range(RINGS) if ring_of(i) == 0}
    with DdpReceiver(nodes * 3) as rx:
        fppd.start()
        percent_lights(fppd, rx, "Row", "Radial Out", 34, expected, nodes,
                       "Radial Out on the submodel",
                       painted={sub_node(i) for i in range(RINGS)})


# --- xLights grid and channel-grid submodels ------------------------------
#
# fppd reads these from config/xlights-submodels.json and
# xlights-modelgroups.json (written by xLights' FPP Connect, or by
# scripts/genXlightsSubmodels.php / genXlightsModelGroups.php), and builds
# one the first time a command names it. A grid cell is a 1-based parent
# node number, landing at (ParentStartChannel - 1) + (node - 1) * 3; a
# channel-grid cell is a '&' list of 1-based absolute start channels. Each
# cell scatters to its channels alone, after the sequence and before the
# ordinary models.

GRID_CHANNELS = 192
PARENT_START = 31  # parent node k (1-based) is at 0-based channel 30 + 3(k - 1)


def grid_parent():
    return matrix("P", start=PARENT_START, width=10, height=5)


def grid_submodel(name, grid, w, h, parent="P", parent_start=PARENT_START):
    """As genXlightsSubmodels.php writes an entry."""
    return {"Name": name, "DisplayName": name, "Type": "Sub", "SubType": "grid",
            "Parent": parent, "ParentStartChannel": parent_start,
            "ChannelCountPerNode": 3, "Width": w, "Height": h, "Grid": grid}


def channel_grid(name, grid, w, h):
    """As genXlightsModelGroups.php writes an entry."""
    return {"Name": name, "DisplayName": name, "Type": "Sub", "SubType": "channelgrid",
            "IsGroup": True, "ChannelCountPerNode": 3, "Width": w, "Height": h,
            "Orientation": "horizontal", "StartCorner": "TL", "StringCount": h,
            "StrandsPerString": 1, "MemberCount": 1, "PixelCount": 7, "Grid": grid}


def install_submodels(fppd, submodels=(), groups=()):
    fppd.write("config/xlights-submodels.json",
               {"source": "xlights", "version": 1, "submodels": list(submodels)})
    if groups:
        fppd.write("config/xlights-modelgroups.json",
                   {"source": "xlights", "version": 1, "modelgroups": list(groups)})


# Both kinds are 3 x 2 with the same cells populated: (0,0), (2,0), (0,1)
# and (1,1); (1,0) and (2,1) are holes. Each populated cell's 0-based
# output channels:
GRID = "5,,12;40,7,"  # parent nodes
CHANNEL_GRID = "1&61,,100;34&37&181,7,"  # 1-based start channels
GRID_TARGETS = {(0, 0): [30 + 3 * 4], (2, 0): [30 + 3 * 11],
                (0, 1): [30 + 3 * 39], (1, 1): [30 + 3 * 6]}
CHANNEL_GRID_TARGETS = {(0, 0): [0, 60], (2, 0): [99],
                        (0, 1): [33, 36, 180], (1, 1): [6]}
# What each cell holds: a blue, a black, a red and a black. The holes hold
# white-ish, which must reach no channel at all.
CELLS = {(0, 0): (0, 0, 200), (2, 0): (0, 0, 0), (0, 1): (200, 0, 0), (1, 1): (0, 0, 0)}
HOLE = (77, 77, 77)
UNDER = 33  # the sequence's value on every channel


def blend(state, cell):
    """What scatterNode() leaves over a node of UNDERs."""
    under = (UNDER,) * 3
    if state == "Enabled":
        return cell
    if state == "Transparent":
        return tuple(c if c else u for c, u in zip(cell, under))
    return cell if any(cell) else under  # TransparentRGB


def expected_frame(targets, colour_of):
    f = bytearray([UNDER]) * GRID_CHANNELS
    for xy, chans in targets.items():
        for ch in chans:
            f[ch:ch + 3] = bytes(colour_of(xy))
    return bytes(f)


def diff(frame, want):
    return [(i, frame[i], want[i]) for i in range(len(want)) if frame[i] != want[i]][:12]


@pytest.mark.parametrize("kind", ["grid", "channelgrid"])
def test_grid_submodel_scatters_its_cells_under_each_overlay_state(fppd, kind):
    """A grid submodel (cells = parent nodes, ParentStartChannel 31) or a
    channel-grid one (cells = lists of absolute channels, a model group),
    over a sequence holding 33 on every channel, with its cells set to
    blue, black, red, black and its two holes to grey, sends:
      - Enabled (Opaque): each cell's colour on each of its channels;
      - Transparent: only the cell's non-zero channels, the sequence's 33s
        in the rest (a black cell shows the sequence);
      - TransparentRGB: a cell with any colour whole, a black one not at all;
      - Disabled: the sequence alone;
    and nothing anywhere else: no hole's colour, no other parent node, none
    of the channels between. A Fill afterwards lights every cell's
    channels and no others."""
    install(fppd, solid_frames(1200, GRID_CHANNELS, UNDER))  # 60 s
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [grid_parent()]})
    if kind == "grid":
        install_submodels(fppd, [grid_submodel("P_Grid", GRID, 3, 2)])
        name, targets = "P_Grid", GRID_TARGETS
    else:
        install_submodels(fppd, groups=[channel_grid("Group", CHANNEL_GRID, 3, 2)])
        name, targets = "Group", CHANNEL_GRID_TARGETS
    data = bytearray()
    for y in range(2):
        for x in range(3):
            data += bytes(CELLS.get((x, y), HOLE))
    with DdpReceiver(GRID_CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        under = bytes([UNDER]) * GRID_CHANNELS
        fppd.wait_for(lambda: rx.last() == under, timeout=15, interval=0.05,
                      what="the sequence on the wire")
        fppd.command("Overlay Model State", name, "Enabled")
        put(fppd, f"model/{name}/data", bytes(data))
        for state in ("Enabled", "Transparent", "TransparentRGB", "Disabled"):
            fppd.command("Overlay Model State", name, state)
            if state == "Disabled":
                want = under
            else:
                want = expected_frame(targets, lambda xy: blend(state, CELLS[xy]))
            try:
                fppd.wait_for(lambda: rx.last() == want, timeout=10, interval=0.05,
                              what=f"{name} {state}")
            except TimeoutError:
                raise AssertionError(f"{name} {state}: (channel, got, wanted) "
                                     f"{diff(rx.last(), want)}")
            time.sleep(0.3)
            assert rx.last() == want, f"{name} {state} changed: {diff(rx.last(), want)}"
        fill(fppd, name, LIT)
        want = expected_frame(targets, lambda xy: LIT)
        try:
            fppd.wait_for(lambda: rx.last() == want, timeout=10, interval=0.05,
                          what=f"{name} filled")
        except TimeoutError:
            raise AssertionError(f"{name} filled: {diff(rx.last(), want)}")


def test_polar_mapping_on_a_grid_submodel(fppd):
    """A grid submodel 7 x 4 whose 24 populated cells (the last column is
    holes) are parent nodes 4-27 in a scrambled order (cell k of the
    populated ones is node 4 + 7k % 24), those nodes laid out as three rings
    (used node u = 7k % 24 on ring u % 3). Radial Out 34% on the submodel
    lights exactly the parent nodes of the inner ring, and Angular CW 25%
    the two spokes at 0 and 45 degrees; the parent's other six nodes, laid
    out on the inner ring too, stay dark, as they are not in the
    submodel."""
    n = 30
    cells = []
    for y in range(4):
        row = []
        for x in range(7):
            if x == 6:
                row.append("")
            else:
                k = y * 6 + x
                row.append(str(4 + 7 * k % 24))
        cells.append(",".join(row))
    setup(fppd, [matrix("Strip", width=n, height=1)], channels=n * 3)
    install_submodels(fppd, [grid_submodel("Strip_Rings", ";".join(cells), 7, 4,
                                           parent="Strip", parent_start=1)])
    node = lambda u: 3 + u  # noqa: E731  0-based parent node of used node u
    pts = three_rings(channel=lambda u: 3 * node(u))
    for i, p in enumerate((0, 1, 2, 27, 28, 29)):
        pts[3 * p] = on_circle(10, 22.5 + 45 * i)
    layout(fppd, pts)
    used = {node(u) for u in range(RINGS)}
    with DdpReceiver(n * 3) as rx:
        fppd.start()
        percent_lights(fppd, rx, "Strip_Rings", "Radial Out", 34,
                       {node(u) for u in range(RINGS) if ring_of(u) == 0}, n,
                       "Radial Out on the grid submodel", painted=used)
        percent_lights(fppd, rx, "Strip_Rings", "Angular CW", 25,
                       {node(u) for u in range(RINGS) if sector_of(u) in (0, 1)}, n,
                       "Angular CW on the grid submodel", painted=used)
