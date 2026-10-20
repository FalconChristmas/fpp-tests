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

from fseq import write_fseq
from show import playlist, sequence_entry

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
