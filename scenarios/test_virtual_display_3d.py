"""The 3D virtual display (HTTPVirtualDisplay3D): the server-sent event
stream the 3D preview page draws from.

Each frame it sends is every lit pixel, grouped by colour:
"RGB:i;j|RGB:k", the colour as three base64 RGB666 characters and i, j, k
the pixel's line number in config/virtualdisplaymap (after the header).
"""

import os
import socket
import time

from test_output_config import B64

PORT = 32339


def display(fppd, pixels, description="3D", **extra):
    """co-other.json with a 3D display, and a map of `pixels`: (x, y, z,
    first channel 0-based), each one RGB. A pixel given as (x, y, ch) is
    written in the map's short form, with no z.

    co-other.json is written to a temp file and renamed into place, as the
    UI's save (WriteFileAtomic) does: one reload per save. Written in place,
    the truncate and the write are two inotify events, and on a Pi 5 the
    second reload landed after the test had moved on."""
    lines = ["100,100"]
    for p in pixels:
        lines.append(",".join(map(str, p)) + ",3,RGB")
    fppd.write("config/virtualdisplaymap", "\n".join(lines) + "\n")
    tmp = fppd.write("config/.co-other.json.tmp", {"channelOutputs": [dict({
        "type": "HTTPVirtualDisplay3D", "enabled": 1, "startChannel": 1,
        "channelCount": 3, "port": PORT, "description": description}, **extra)]})
    os.rename(tmp, os.path.join(fppd.media, "config", "co-other.json"))


def connect(timeout=2):
    return socket.create_connection(("127.0.0.1", PORT), timeout=timeout)


def wait_listening(fppd):
    def up():
        try:
            connect(1).close()
            return True
        except OSError:
            return False
    fppd.wait_for(up, timeout=10, what="the 3D display's port")


def events(seconds, sock=None, first=5):
    """(event, data) for each event the display sends in `seconds`, counted
    from its first one (a new connection waits up to `first` seconds for
    that: it is a second or so before the display starts writing to it)."""
    s = sock or connect()
    s.settimeout(0.2)
    data = b""
    end = time.monotonic() + first
    started = False
    while time.monotonic() < end:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        data += chunk
        if not started and b"event: " in data:
            started = True
            end = time.monotonic() + seconds
    if sock is None:
        s.close()
    out = []
    for block in data.decode(errors="replace").replace("\r\n", "\n").split("\n\n"):
        ev = dt = None
        for line in block.split("\n"):
            if line.startswith("event: "):
                ev = line[len("event: "):]
            elif line.startswith("data: "):
                dt = line[len("data: "):]
        if ev:
            out.append((ev, dt or ""))
    return out


def frame(data):
    """{colour: {pixel index, ...}} for one message's data."""
    out = {}
    for group in data.split("|"):
        colour, _, idx = group.partition(":")
        out[colour] = {int(i) for i in idx.split(";")}
    return out


def colour(value):
    return B64[value >> 2] * 3


def frames(seconds):
    return [frame(d) for e, d in events(seconds) if e == "message" and d]


def test_lit_pixels_stream_by_colour_and_map_index(fppd):
    """Pixels whose channels start well past channel 1 show their own
    channels' colours, grouped by colour, listed by map line, dark pixels
    left out; the map's short (no z) lines count the same as full ones.
    The display is 683fdb52d's.

    Regression: af5528025. Init() rebased every pixel's channel by the
    lowest channel in the map, but PrepData() is handed the whole sequence
    buffer: each pixel showed channel ch - 300 here, which is dark, so the
    display sent nothing but pings.
    """
    display(fppd, [(0, 0, 0, 300), (1, 0, 0, 303), (2, 0, 306), (3, 0, 0, 309)])
    fppd.start()
    wait_listening(fppd)
    fppd.request("PUT", "/overlays/range/301-303", {"Value": 200})
    fppd.request("PUT", "/overlays/range/307-312", {"Value": 100})
    fppd.request("PUT", "/overlays/range/310-312", {"Value": 200})
    want = {colour(200): {0, 3}, colour(100): {2}}
    got = frames(2)
    assert got, "the display sent no frames with the pixels lit"
    assert want in got, f"expected {want}, the display sent {got[-3:]}"


def test_going_dark_sends_one_black_frame_then_pings(fppd):
    """When everything goes dark the display sends one frame listing every
    pixel as black, so the preview clears, and then only keep-alive pings."""
    display(fppd, [(0, 0, 0, 0), (1, 0, 0, 3), (2, 0, 0, 6)])
    fppd.start()
    wait_listening(fppd)
    fppd.request("PUT", "/overlays/range/1-9", {"Value": 120})
    s = connect()
    try:
        lit = [frame(d) for e, d in events(1.5, s) if e == "message" and d]
        assert {colour(120): {0, 1, 2}} in lit, f"the lit pixels never arrived: {lit[-3:]}"
        fppd.request("PUT", "/overlays/range/1-9", {"Value": 0})
        after = events(3, s, first=1)
    finally:
        s.close()
    msgs = [frame(d) for e, d in after if e == "message" and d]
    black = [m for m in msgs if m == {"000": {0, 1, 2}}]
    assert black, f"no all-black frame after the lights went out: {msgs[-3:]}"
    tail = after[[i for i, (e, d) in enumerate(after) if e == "message" and
                  frame(d) == {"000": {0, 1, 2}}][-1] + 1:]
    assert tail and all(e == "ping" for e, _ in tail), \
        f"the dark display kept sending frames: {tail[:5]}"


def test_update_interval_limits_the_frame_rate(fppd):
    """updateInterval is the time between frames sent, whatever the output
    frame rate: 100 ms is about ten a second."""
    display(fppd, [(0, 0, 0, 0)], updateInterval=100)
    fppd.start()
    wait_listening(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 255})
    n = len(events(3))
    assert 15 <= n <= 36, f"{n} events in 3 s at a 100 ms update interval"


def test_every_connection_is_served_after_config_reloads(fppd):
    """After the output config is saved (and the display re-created) a few
    times, every new connection to the display's port gets frames.

    Regression: bc99a712c. The display never closed its listening socket and
    bound with SO_REUSEPORT, so each reload left the old listener open beside
    the new one and the kernel spread connections across all of them: after
    three reloads about three in four connections went to a listener nobody
    accepted on, and hung.
    """
    pixels = [(0, 0, 0, 0)]
    display(fppd, pixels)
    fppd.start()
    wait_listening(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 255})
    started = lambda: fppd.log().count("HTTPVirtualDisplay3D listening on port")
    for i in range(3):
        before = started()
        display(fppd, pixels, description=f"3D reload {i}")
        fppd.wait_for(lambda: started() > before, timeout=15,
                      what=f"reload {i + 1} to re-create the display")
        time.sleep(0.5)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 255})
    starved = 0
    for _ in range(16):
        if not [e for e, _ in events(0.1, first=3) if e in ("message", "ping")]:
            starved += 1
    assert not starved, f"{starved} of 16 connections got nothing after three reloads"


def test_clients_come_and_go_while_it_streams(fppd):
    """Preview clients that connect, take a frame and hang up, one after
    another and two at a time, are each served, and leave the display
    serving the next.

    Regression (TSan): 73f7fd82d. The accept thread set m_connListChanged
    under the connection list's lock while the select thread read it
    without, a volatile bool shared between threads; c08e4f453 had made the
    same flags atomic on the 2D display only.
    """
    display(fppd, [(0, 0, 0, 0), (1, 0, 0, 3)])
    fppd.start()
    wait_listening(fppd)
    fppd.request("PUT", "/overlays/range/1-6", {"Value": 255})
    want = {colour(255): {0, 1}}
    for i in range(8):
        a = connect()
        b = connect() if i % 2 else None
        try:
            for s in filter(None, (a, b)):
                got = [frame(d) for e, d in events(0.1, s, first=5) if e == "message" and d]
                assert want in got, f"client {i} got {got[-2:]}"
        finally:
            a.close()
            if b:
                b.close()
