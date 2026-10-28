"""The ColorLight 5A-75 LED panel output, captured off the wire.

It sends raw Ethernet frames: per frame, rows of pixel data (type 0x55: row,
pixel offset, pixel count, then RGB), then a display packet (0x01) that
makes the receiver show them; a brightness packet (0x0A) leads. Here the
output goes out one end of a veth pair and the other end is captured, so
the receiver's view of each frame can be rebuilt and checked against the
channel data a sequence put in.

Every pixel of the sequence's frame has its own value (its index in the
first two bytes), so where each one landed can be read back.
"""

import contextlib
import itertools
import os
import socket
import struct
import subprocess
import threading
import time

import pytest

from ddp import DdpReceiver
from fseq import write_fseq
from show import ddp_output, playlist, sequence_entry

TX, RX = "fpptcl0", "fpptcl1"
SRC_MAC = bytes.fromhex("222233445566")


@contextlib.contextmanager
def veth():
    def ip(*a):
        return subprocess.run(["ip", *a], capture_output=True, text=True)
    ip("link", "del", TX)
    r = ip("link", "add", TX, "type", "veth", "peer", "name", RX)
    if r.returncode:
        pytest.skip(f"cannot add a veth pair: {r.stderr.strip()}")
    try:
        ip("link", "set", TX, "up")
        ip("link", "set", RX, "up")
        yield
    finally:
        ip("link", "del", TX)


class Capture:
    """Raw frames arriving on RX from the ColorLight output's source MAC."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        self.sock.bind((RX, 0))
        self.sock.settimeout(0.2)
        self.packets = []
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                pkt = self.sock.recv(4096)
            except socket.timeout:
                continue
            if pkt[6:12] == SRC_MAC:
                with self.lock:
                    self.packets.append(pkt)
                    del self.packets[:-4000]

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def frames(self):
        """Each complete frame as (pixel packets, rows {row: bytes}), in order:
        everything between one display packet and the next."""
        with self.lock:
            pkts = list(self.packets)
        out, cur = [], []
        seen_sync = False
        for p in pkts:
            t = p[12]
            if t == 0x01:
                if seen_sync and cur:
                    out.append(cur)
                cur, seen_sync = [], True
            elif t == 0x55 and seen_sync:
                cur.append(p)
        frames = []
        for f in out:
            rows = {}
            for p in f:
                row, off, count = struct.unpack(">HHH", p[13:19])
                data = p[21:21 + count * 3]
                buf = rows.setdefault(row, bytearray())
                if len(buf) < (off + count) * 3:
                    buf.extend(bytes((off + count) * 3 - len(buf)))
                buf[off * 3:(off + count) * 3] = data
            frames.append((f, {r: bytes(b) for r, b in rows.items()}))
        return frames

    def types(self):
        with self.lock:
            return [p[12] for p in self.packets]


def unique_frame(width, height):
    """A width x height RGB frame whose pixel i is (i >> 8, i & 0xFF, 0x5A)."""
    return b"".join(bytes(((i >> 8) & 0xFF, i & 0xFF, 0x5A)) for i in range(width * height))


def pixel_at(frame, width, x, y):
    i = (y * width + x) * 3
    return frame[i:i + 3]


def panels_output(panels, width=32, height=16, channels=None, **extra):
    cfg = {"type": "LEDPanelMatrix", "subType": "ColorLight5a75", "enabled": 1,
           "startChannel": 1, "channelCount": channels or 0, "interface": TX,
           "linkCheck": False, "firmwareVersion": 12, "panelWidth": width, "panelHeight": height,
           "cfgVersion": 2, "colorOrder": "RGB", "panels": panels}
    cfg.update(extra)
    return {"channelOutputs": [cfg]}


def panel(output, number, x, y, orientation="N", color="RGB"):
    return {"outputNumber": output, "panelNumber": number, "xOffset": x, "yOffset": y,
            "orientation": orientation, "colorOrder": color}


def play(fppd, frame, cfg):
    fppd.write("config/channeloutputs.json", cfg)
    write_fseq(os.path.join(fppd.media, "sequences", "P.fseq"), [frame] * 20, step_ms=50)
    fppd.write("playlists/P.json", playlist("P", [sequence_entry("P.fseq")]))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Start Playlist", "P", "true", "false")


@contextlib.contextmanager
def captured():
    with veth():
        cap = Capture()
        try:
            yield cap
        finally:
            cap.close()


def lit_frame(fppd, cap, rows, row_bytes):
    """The latest captured frame once it carries the sequence's data
    (pixel 0 of the sequence is never all zero in the last byte)."""
    def ready():
        fs = cap.frames()
        if not fs:
            return None
        pkts, got = fs[-1]
        if sorted(got) == list(range(rows)) and all(len(got[r]) == row_bytes for r in got) \
                and any(got[r][2::3].count(0x5A) for r in got):
            return pkts, got
        return None
    return fppd.wait_for(ready, timeout=15, interval=0.2, what="a full frame of the sequence on the wire")


def test_one_panel_shows_the_frame_as_it_is(fppd):
    """One 32x16 panel: receiver row y holds matrix row y, pixel for pixel,
    and each row fits one packet."""
    w, h = 32, 16
    frame = unique_frame(w, h)
    with captured() as cap:
        play(fppd, frame, panels_output([panel(0, 0, 0, 0)], channels=w * h * 3))
        pkts, rows = lit_frame(fppd, cap, h, w * 3)
    assert {struct.unpack('>HHH', p[13:19]) for p in pkts} == {(y, 0, w) for y in range(h)}
    for y in range(h):
        assert rows[y] == frame[y * w * 3:(y + 1) * w * 3], f"row {y}"


def test_a_long_chain_splits_each_row_into_packets(fppd):
    """Sixteen 32-wide panels in a chain make a 512-pixel row, more than one
    packet holds (497): each row goes as 497 + 15, offsets and counts to
    match, and the rebuilt rows are the matrix rows."""
    w, h, n = 32, 16, 16
    frame = unique_frame(w * n, h)
    panels = [panel(0, i, i * w, 0) for i in range(n)]
    with captured() as cap:
        play(fppd, frame, panels_output(panels, channels=w * n * h * 3))
        pkts, rows = lit_frame(fppd, cap, h, w * n * 3)
    heads = sorted({struct.unpack(">HHH", p[13:19]) for p in pkts})
    assert heads[:2] == [(0, 0, 497), (0, 497, 15)], heads[:4]
    seen = set()
    for y in range(h):
        for c in range(w * n):
            seen.add(rows[y][c * 3:c * 3 + 3])
    assert len(seen) == w * n * h, "pixels missing or duplicated on the wire"


def block(rows, output, chain, w, h, chain_len):
    """The w x h block the receiver shows for (output, chain position):
    a list of rows of pixels."""
    out = []
    for y in range(h):
        r = rows[output * h + y]
        out.append([r[(chain * w + x) * 3:(chain * w + x) * 3 + 3] for x in range(w)])
    return out


def test_layout_orientation_and_color_order(fppd):
    """Two outputs of two panels each, a 64x32 matrix: every matrix pixel
    reaches the wire exactly once, each panel shows its own rectangle, an
    upside-down ("U") panel shows it turned 180 degrees, and a GRB panel
    swaps red and green.

    The chain position comes from cfgVersion 2's numbering: panel 0 is the
    one nearest the receiver, which the receiver's row data puts last.
    """
    w, h = 32, 16
    W, H = 64, 32
    frame = unique_frame(W, H)
    panels = [panel(0, 0, 0, 0), panel(0, 1, 32, 0, "U"),
              panel(1, 0, 0, 16, color="GRB"), panel(1, 1, 32, 16)]
    with captured() as cap:
        play(fppd, frame, panels_output(panels, channels=W * H * 3))
        pkts, rows = lit_frame(fppd, cap, 2 * h, 2 * w * 3)

    def matrix(x, y):
        return pixel_at(frame, W, x, y)

    def at(output, number):  # cfgVersion 2: panel 0 is last in the row data
        return block(rows, output, 1 - number, w, h, 2)

    p00, p01, p10, p11 = at(0, 0), at(0, 1), at(1, 0), at(1, 1)
    # Every matrix pixel exactly once, reading the GRB panel back as RGB.
    every = [px for b in (p00, p01, p11) for r in b for px in r]
    every += [bytes((px[1], px[0], px[2])) for r in p10 for px in r]
    assert len(set(every)) == W * H == len(every), "pixels missing or duplicated on the wire"
    for y in range(h):
        for x in range(w):
            assert p00[y][x] == matrix(x, y), ("N", x, y)
            assert p01[y][x] == matrix(32 + w - 1 - x, h - 1 - y), ("U", x, y)
            r, g, b = matrix(x, 16 + y)
            assert p10[y][x] == bytes((g, r, b)), ("GRB", x, y)
            assert p11[y][x] == matrix(32 + x, 16 + y), ("N on output 1", x, y)


def test_brightness_and_newer_firmware_packets(fppd):
    """Brightness 50% goes out as 127 in the brightness and display packets,
    and firmware 13 and later gets each of those twice."""
    w, h = 32, 16
    with captured() as cap:
        play(fppd, unique_frame(w, h),
             panels_output([panel(0, 0, 0, 0)], channels=w * h * 3, brightness=50, firmwareVersion=13))
        lit_frame(fppd, cap, h, w * 3)
        with cap.lock:
            pkts = list(cap.packets)
    brightness = [p for p in pkts if p[12] == 0x0A]
    sync = [p for p in pkts if p[12] == 0x01]
    assert brightness and brightness[-1][13:16] == bytes([127] * 3), brightness[-1][13:17].hex()
    assert sync[-1][13 + 22] == 127 and sync[-1][13 + 25:13 + 28] == bytes([127] * 3)
    # Runs of one packet type, leaving out the first and last: the snapshot
    # can start or end half way through a pair. A run of 1 is a packet the
    # capture dropped; firmware before 13 sends nothing but runs of 1.
    runs = [(t, len(list(g))) for t, g in itertools.groupby(p[12] for p in pkts)][1:-1]
    display = [n for t, n in runs if t == 0x01]
    bright = [n for t, n in runs if t == 0x0A]
    assert 2 in display and max(display) == 2, f"firmware 13 sends the display packet twice: {display}"
    assert 2 in bright and max(bright) == 2, f"firmware 13 sends the brightness packet twice: {bright}"


def test_output_specific_test_pattern_cycles(fppd):
    """Test Start "Output Specific" with no channel range, as the Pixel
    Count button and the outputs' test dropdowns send it: the panel layout
    pattern steps through its colours once per cycle, so the left column of
    a panel shows green, then red, then blue.

    Regression: dbfa6fceb. A test pattern with no channels of its own was no
    longer cycled, and an Output Specific test never has any: every output's
    test (and every string tester) saw cycle 0 for as long as it ran, so the
    left column stayed green."""
    w, h = 32, 16
    with captured() as cap:
        fppd.write("config/channeloutputs.json", panels_output([panel(0, 0, 0, 0)], channels=w * h * 3))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "100", "Output Specific", "--ALL--", "1")
        seen = set()

        def all_three():
            for _, rows in cap.frames():
                if 1 in rows and len(rows[1]) >= 3:
                    seen.add(rows[1][0:3])
            return {b"\x00\xff\x00", b"\xff\x00\x00", b"\x00\x00\xff"} <= seen
        try:
            fppd.wait_for(all_three, timeout=10, interval=0.2,
                          what="the left column to show green, red and blue")
        finally:
            fppd.command("Test Stop")


@pytest.mark.parametrize("order", ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"])
def test_output_specific_colour_fades_follow_the_color_order(fppd, order):
    """The LED Panels page's Red/Green/Blue Fade tests light the colour they
    name on a panel of any color order: a red fade goes out on the wire the
    color order gives red, as red in a sequence would.

    Regression: #2891. The test wrote through the panel's pixel map, the
    same map the output reads the wires through, so the color order cancelled
    out and a red fade always went out on the first wire."""
    w, h = 32, 16
    with captured() as cap:
        fppd.write("config/channeloutputs.json",
                   panels_output([panel(0, 0, 0, 0, color=order)], channels=w * h * 3))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        for test_type, colour in ((4, "R"), (5, "G"), (6, "B")):
            wire = order.index(colour)
            fppd.command("Test Start", "100", "Output Specific", "--ALL--", str(test_type))
            with cap.lock:  # only frames from this fade
                cap.packets.clear()

            def lit():
                # The newest two lit frames agreeing: a frame of the previous
                # fade still in flight at the clear can't decide it.
                seen = [px for _, rows in cap.frames()
                        if len(px := rows.get(0, b"")[0:3]) == 3 and any(px)]
                if len(seen) >= 2 and [i for i in range(3) if seen[-1][i]] == \
                        [i for i in range(3) if seen[-2][i]]:
                    return seen[-1]
                return None
            try:
                px = fppd.wait_for(lit, timeout=10, interval=0.2,
                                   what=f"the {colour} fade on the wire")
            finally:
                fppd.command("Test Stop")
            assert [i for i in range(3) if px[i]] == [wire], \
                f"{colour} fade on a {order} panel went out as {px.hex()}, expected wire {wire}"


@pytest.mark.parametrize("sub, what", [
    ({"width": 64, "height": 16, "xOffset": 0, "yOffset": 0}, "wider than the matrix"),
    ({"width": 8, "height": 8, "xOffset": 28, "yOffset": 12}, "hanging off its corner"),
    ({"width": 8, "height": 8, "xOffset": -4, "yOffset": 0}, "at a negative offset"),
])
def test_a_sub_matrix_that_does_not_fit_is_ignored(fppd, sub, what):
    """A sub-matrix that doesn't fit inside its panel matrix is refused, and
    the matrix shows its own channels as if it weren't there.

    Regression: 7eef3246a. Its geometry was never checked: every frame
    copied it row by row into the matrix's buffer, past the end of it."""
    w, h = 32, 16
    frame = unique_frame(w, h)
    cfg = panels_output([panel(0, 0, 0, 0)], channels=w * h * 3,
                        subMatrices=[dict(sub, enabled=1, startChannel=1)])
    with captured() as cap:
        play(fppd, frame, cfg)
        pkts, rows = lit_frame(fppd, cap, h, w * 3)
    for y in range(h):
        assert rows[y] == frame[y * w * 3:(y + 1) * w * 3], f"row {y} with a sub-matrix {what}"


def test_a_panel_offset_past_the_channel_buffer_is_refused(fppd):
    """A panel whose offset would make the matrix need more channels than
    fppd has is refused, and the matrix shows its other panel as if the bad
    one weren't there.

    Regression: 901c07c94. Offsets had a lower bound only: one in
    the millions grew the matrix to match, and its width * height (the
    outputs' channel count and the size of their buffers) past the channel
    buffer, or past an int."""
    w, h = 32, 16
    frame = unique_frame(w, h)
    cfg = panels_output([panel(0, 0, 0, 0), panel(0, 1, 2000000, 0)], channels=w * h * 3)
    with captured() as cap:
        play(fppd, frame, cfg)
        pkts, rows = lit_frame(fppd, cap, h, w * 3)
    for y in range(h):
        assert rows[y] == frame[y * w * 3:(y + 1) * w * 3], f"row {y}"


@pytest.mark.parametrize("bad, what", [
    (panel(3, 0, 0, 16, orientation="X"), "an orientation it doesn't know, on output 3"),
    (panel(0, 30, 32, 0), "chain position 30, past the 24 an output takes"),
])
def test_a_refused_panel_does_not_grow_the_matrix(fppd, bad, what):
    """A panel the matrix refuses doesn't count toward its outputs or its
    longest chain: beside one good 32x16 panel, the receiver still gets 16
    rows of 32 pixels, the good panel's.

    Regression: f11ee60c8. ColorLight ignored AddPanel()'s result and
    counted every panel's output and chain anyway, so a refused panel on
    output 3 made every frame 64 rows, and one at chain position 30 (which
    nothing refused before) made every row 31 panels long.
    """
    w, h = 32, 16
    frame = unique_frame(w, h)
    cfg = panels_output([panel(0, 0, 0, 0), bad], channels=w * h * 3)
    with captured() as cap:
        play(fppd, frame, cfg)
        try:
            pkts, rows = lit_frame(fppd, cap, h, w * 3)
        except TimeoutError:
            fs = cap.frames()
            shape = sorted({(r, len(b) // 3) for r, b in fs[-1][1].items()})[-1:] if fs else None
            raise AssertionError(f"beside {what}: no 16-row, 32-pixel frame; last frame's "
                                 f"last (row, pixels): {shape}, {len(fs[-1][1]) if fs else 0} rows")
    for y in range(h):
        assert rows[y] == frame[y * w * 3:(y + 1) * w * 3], f"row {y} beside {what}"


def test_an_overlong_interface_name_is_refused(fppd):
    """A ColorLight output configured (by hand) with an interface name far
    longer than an interface name can be fails to start, with a warning,
    and fppd lives.

    Regression: 799afeec1. Init() strcpy()'d the name into an ifreq member
    of the output, so 2000 characters wrote far past the end of the object:
    a heap-buffer-overflow at startup. (A name of 16-40 characters stays
    inside the object and ASan can't see it, hence the length.)
    """
    fppd.write("config/channeloutputs.json",
               panels_output([panel(0, 0, 0, 0)], channels=32 * 16 * 3, interface="x" * 2000))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: any("ColorLight5a75" in w for w in
                              fppd.get("/fppd/status").get("warnings", [])),
                  timeout=10, what="the could-not-initialize warning")
    time.sleep(1)


def tc(*a):
    return subprocess.run(["tc", *a], capture_output=True, text=True)


def play_with_ddp(fppd, frames, cfg, step_ms=25):
    """The ColorLight output plus a DDP output on the same channels, so the
    output thread's pace can be read off a second output's frames."""
    fppd.write("config/channeloutputs.json", cfg)
    fppd.write("config/co-universes.json", ddp_output(150))
    write_fseq(os.path.join(fppd.media, "sequences", "P.fseq"), frames, step_ms=step_ms)
    fppd.write("playlists/P.json", playlist("P", [sequence_entry("P.fseq")]))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Start Playlist", "P", "true", "false")


def warnings(fppd):
    return fppd.get("/fppd/warnings")


def test_an_interface_that_goes_down_does_not_hold_up_the_other_outputs(fppd):
    """The ColorLight interface going down mid-show (a USB NIC unplugged or
    reset) leaves the output thread at the sequence's 40fps: a DDP output
    beside it keeps its frame rate. A warning names the interface and the
    error while it is down, and comes down once frames go out again.

    Regression: 1fbc8cf33. Every failed send was retried, 500us apart, for
    22ms, once for the rows and again for the display packet, all on the
    output thread: with the interface down every frame lost ~45ms, and the
    show ran at about 20fps.
    """
    w, h = 32, 16
    frame = unique_frame(w, h)
    with captured() as cap, DdpReceiver(150) as rx:
        play_with_ddp(fppd, [frame] * 2400,
                      panels_output([panel(0, 0, 0, 0)], channels=w * h * 3))
        lit_frame(fppd, cap, h, w * 3)

        subprocess.run(["ip", "link", "set", TX, "down"], check=True)
        time.sleep(0.5)
        t0 = time.monotonic()
        time.sleep(3)
        fps = rx.count(since=t0) / (time.monotonic() - t0)
        assert fps >= 32, f"with the ColorLight interface down, the DDP output ran at {fps:.1f}fps, not 40"
        assert any(f"Unable to send on interface {TX}" in m for m in warnings(fppd)), warnings(fppd)

        subprocess.run(["ip", "link", "set", TX, "up"], check=True)
        fppd.wait_for(lambda: not any("Unable to send" in m for m in warnings(fppd)),
                      timeout=5, what="the unable-to-send warning to come down")
        seen = len(cap.frames())
        fppd.wait_for(lambda: len(cap.frames()) > seen + 5, timeout=5,
                      what="frames on the wire again once the interface is back")


def test_a_link_too_slow_for_the_frames_drops_them_whole(fppd):
    """A ColorLight link that can't carry every frame (here a 4Mbit tbf on
    the interface, against 40fps of 48KB frames) drops frames, but only
    whole ones: every frame the receiver is told to show has all its rows.
    A warning says frames are being dropped.

    Regression: 1fbc8cf33. A send that didn't fit was retried for up to
    22ms and then given up part way, and the display packet went out after
    it anyway: the receiver showed torn frames, new rows over stale ones.
    """
    w, h = 64, 32
    W, H = 4 * w, 2 * h
    frame = unique_frame(W, H)
    panels = [panel(o, i, i * w, o * h) for o in range(2) for i in range(4)]
    with captured() as cap, DdpReceiver(150):
        play_with_ddp(fppd, [frame] * 2400, panels_output(panels, w, h, channels=W * H * 3))
        lit_frame(fppd, cap, H, W * 3)

        r = tc("qdisc", "replace", "dev", TX, "root", "tbf", "rate", "4mbit", "burst", "16kb", "latency", "500ms")
        if r.returncode:
            pytest.skip(f"cannot shape {TX}: {r.stderr.strip()}")
        try:
            time.sleep(1)
            with cap.lock:
                cap.packets.clear()
            time.sleep(4)
            frames = cap.frames()
            dropping = any("frames are being dropped" in m for m in warnings(fppd))
        finally:
            tc("qdisc", "del", "dev", TX, "root")

    assert frames, "no frame reached the receiver over the slow link"
    torn = [(i, len(rows)) for i, (_, rows) in enumerate(frames)
            if sorted(rows) != list(range(H)) or any(len(b) != W * 3 for b in rows.values())]
    assert not torn, f"{len(torn)} of {len(frames)} frames were shown with rows missing: (frame, rows) {torn[:5]}"
    assert len(frames) < 4 * 40 * 0.6, f"{len(frames)} frames shown in 4s over a link that carries ~10fps"
    assert dropping, "no dropped-frames warning"


@pytest.mark.parametrize("test_type, colour", [(4, "red"), (5, "green"), (6, "blue"), (7, "white")])
def test_output_specific_colour_fade_ramps_the_whole_panel(fppd, test_type, colour):
    """The LED Panels page's colour fade tests fill the whole panel with
    one colour whose level ramps up and down over each cycle: every pixel of
    a frame is the same, only the channels of the fade's colour are lit
    (all three, equally, for white), and over a cycle the level runs from
    near dark to near full through many steps.

    Regression: fea43549f added the fades. Before it a panel drew its
    layout pattern for every test type: a solid colour per cycle with the
    panel's numbers on it, never a ramp."""
    w, h = 32, 16
    lit = {"red": (0,), "green": (1,), "blue": (2,), "white": (0, 1, 2)}[colour]
    with captured() as cap:
        fppd.write("config/channeloutputs.json",
                   panels_output([panel(0, 0, 0, 0)], channels=w * h * 3))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "2000", "Output Specific", "--ALL--", str(test_type))
        try:
            time.sleep(0.5)
            with cap.lock:
                cap.packets.clear()
            time.sleep(4.5)  # over two whole cycles
            frames = [rows for _, rows in cap.frames()
                      if sorted(rows) == list(range(h)) and all(len(rows[r]) == w * 3 for r in rows)]
        finally:
            fppd.command("Test Stop")
    assert len(frames) >= 10, f"only {len(frames)} whole frames in 4.5 s"
    levels = set()
    for rows in frames:
        px = rows[0][0:3]
        pixels = {rows[r][i:i + 3] for r in rows for i in range(0, w * 3, 3)}
        assert pixels == {px}, f"a {colour} fade frame is not one colour: {sorted(p.hex() for p in pixels)[:6]}"
        assert all(px[c] == 0 for c in range(3) if c not in lit), f"{colour} fade lit {px.hex()}"
        assert len({px[c] for c in lit}) == 1, f"{colour} fade lit {px.hex()}"
        levels.add(px[lit[0]])
    assert len(levels) >= 6 and min(levels) < 96 and max(levels) > 160, \
        f"the {colour} fade did not ramp: levels {sorted(levels)}"


def test_a_bridged_frame_is_latched_after_its_rows_have_left(fppd):
    """While fppd bridges network input (DDP here), each frame's display
    packet goes out at least ColorlightSyncGapUS (500 us) after the frame's
    last row left, measured by the kernel's receive timestamps on the far
    end of the veth.

    Regression: 3a8e4f707. Bridging runs PrepData() and SendData() back to
    back, so the display packet followed the last row by 0-300 us and the
    receiver latched before it had stored that row: the last row lit only
    part way, differently every frame (#3136)."""
    from packets import DDP_PORT, ddp, send
    from test_bridge_inputs import inputs
    w, h = 32, 16
    SO_TIMESTAMPNS = 35
    fppd.write("config/channeloutputs.json", panels_output([panel(0, 0, 0, 0)], channels=w * h * 3))
    fppd.write("config/ci-universes.json", inputs())
    fppd.settings(DisableFakeNetworkBridges="1")
    gaps = []
    with veth():
        sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
        sock.bind((RX, 0))
        sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
        sock.settimeout(0.2)
        try:
            fppd.start()
            frame = unique_frame(w, h)
            last_row = None
            ends = time.monotonic() + 30
            n = 0
            while len(gaps) < 60 and time.monotonic() < ends:
                n += 1
                send([ddp(off, frame[off:off + 1440], push=off + 1440 >= len(frame), seq=n % 15 + 1)
                      for off in range(0, len(frame), 1440)], DDP_PORT)
                stop = time.monotonic() + 0.04
                while time.monotonic() < stop:
                    try:
                        pkt, anc, _, _ = sock.recvmsg(4096, 64)
                    except socket.timeout:
                        break
                    if pkt[6:12] != SRC_MAC:
                        continue
                    sec, nsec = struct.unpack("ll", anc[0][2][:16])
                    t = sec * 1_000_000 + nsec // 1000
                    if pkt[12] == 0x55:
                        last_row = t
                    elif pkt[12] == 0x01 and last_row is not None:
                        gaps.append(t - last_row)
                        last_row = None
        finally:
            sock.close()
    assert len(gaps) >= 30, f"only {len(gaps)} bridged frames were latched on the wire"
    gaps.sort()
    assert gaps[len(gaps) // 10] >= 400, \
        f"display packets followed the last row by {gaps[:10]}... us (median {gaps[len(gaps) // 2]} us)"
