"""Channel output configs fppd can only partly use, warnings that must come
down with a fix, and serial outputs written into a pty."""

import json
import os
import time

import pytest

from ddp import DdpReceiver
from serial import PtyReader
from show import ddp_output

CHANNELS = 150


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def range_on(fppd, channels, value):
    """Light channels 1..channels with an overlay range, so outputs send."""
    fppd.request("PUT", f"/overlays/range/1-{channels}", {"Value": value})


def test_wrong_typed_output_config_is_skipped(fppd):
    """fppd starts with an output config it can't read ("enabled": "yes"),
    skips that output, and drives the rest.

    Regression: bd399d8fc. The loader read type, enabled, start and count
    with asInt()/asString() outside its try block; jsoncpp threw on the
    wrong type and fppd died, at startup and on every restart after.
    """
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericUDP", "enabled": "yes", "startChannel": "1", "channelCount": 10,
        "address": "127.0.0.1", "port": 9999, "tokens": "{data}"}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        range_on(fppd, 10, 42)
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the good output to send")


def test_fixed_output_config_takes_its_warning_down(fppd):
    """A UDP output aimed at fppd itself raises a warning; once the config is
    fixed and saved, the warning comes down.

    Regression: a45599933. The warnings the UDP output raised while loading
    ("sending to myself", an unresolvable host, a bad interface) had no
    matching removal, so the banner stayed up after the fix until fppd
    restarted.
    """
    def flagged():
        return any("send data to myself" in w for w in warnings(fppd))

    fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.1"))
    fppd.start()
    fppd.wait_for(flagged, timeout=10, what="the sending-to-myself warning")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.2"))
    fppd.wait_for(lambda: not flagged(), timeout=15, interval=0.5,
                  what="the warning to come down after the fix")


class SlowPty(PtyReader):
    """A pty read more slowly than the output writes to it, as a slow serial
    line or a busy receiver is, until fast() makes it drain what's queued."""

    def __init__(self, chunk=1024, every=0.05):
        self.chunk, self.every = chunk, every
        super().__init__()

    def fast(self):
        self.chunk, self.every = 65536, 0.002

    def _run(self):
        while self.running:
            try:
                piece = os.read(self.master, self.chunk)
            except BlockingIOError:
                piece = b""
            except OSError:
                break
            with self.lock:
                self.data += piece
            time.sleep(self.every)

    def raw(self):
        with self.lock:
            return bytes(self.data)


def test_generic_serial_sends_whole_frames_to_a_slow_reader(fppd):
    """GenericSerial into a pty read more slowly than it writes sends every
    frame whole: header, all its channels, footer.

    Regression: 4447ea75c. The port is non-blocking and each frame was one
    write(); once the tty buffer had less room than a frame, the tail was
    dropped and the next frame's header followed a truncated one, which a
    receiver can't resynchronise from.

    Regression: 7d9819ba0. The footer was sized from the header, which Init()
    had not read yet, so it was never sent: every frame ended at its last
    channel.

    Regression: 01b575503 (verify with --flavor tsan). StartOutputThread()
    polled m_threadIsRunning and m_runThread with no lock while the new
    worker set them under m_sendLock; TSan reported it as the output
    started.
    """
    # 2000 channels at 20 fps is about 40 KB/s and the reader takes 20 KB/s:
    # the pty's buffer fills, but a frame's worth of room comes free well
    # within the 500 ms the output waits for it.
    n = 2000
    with SlowPty() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": n,
            "device": pty.device, "speed": 115200, "header": "HDR", "footer": "END"}]})
        fppd.start()
        range_on(fppd, n, 0x80)
        time.sleep(6)          # slow: the pty's buffer fills
        pty.fast()
        time.sleep(3)          # then drain everything it queued
        data = pty.raw()
    frames = data.split(b"HDR")[1:-1]  # the last one may still be arriving
    assert len(frames) >= 20, f"only {len(frames)} frames arrived"
    # What a frame holds depends on how far the slow reader has got (the
    # first are from before the range took effect); every one must be all its
    # channels and then the footer.
    bad = [len(f) for f in frames if len(f) != n + 3 or not f.endswith(b"END")]
    assert not bad, f"{len(bad)} of {len(frames)} frames were not whole: lengths {bad[:10]}"


def test_renard_at_an_unlisted_speed_fails_once(fppd):
    """A Renard output at a speed FPP has no channel limit for fails to start
    with one message, instead of refusing, and logging, every frame.

    Regression: 292c5fc81. An unlisted speed has a limit of 0 channels, so
    SendData() refused every frame and logged an error for each.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "Renard", "enabled": 1, "startChannel": 1, "channelCount": 24,
            "device": pty.device, "renardspeed": 12345, "renardparm": "8N1"}]})
        fppd.start()
        range_on(fppd, 24, 0x40)
        time.sleep(3)
    refusals = fppd.log().count("tried to send")
    assert refusals <= 1, f"{refusals} frames refused and logged in 3 s"


def fds_on(pid, device):
    path = "/dev/" + device
    found = []
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            if os.readlink(f"/proc/{pid}/fd/{fd}") == path:
                found.append(fd)
        except OSError:
            pass
    return found


def test_serial_output_that_fails_init_releases_its_port(fppd):
    """A DMX-Open output whose setup fails after its port opened (a pty has
    no RTS line) leaves the port closed, so the next config can use it.

    Regression: 014212fb1. An output whose Init() failed after opening was
    deleted without Close(), and the serial destructor never closed the fd;
    the port stayed open with TIOCEXCL, so every later open of it failed as
    "in use" until fppd restarted.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "DMX-Open", "enabled": 1, "startChannel": 1, "channelCount": 16,
            "device": pty.device}]})
        fppd.start()
        time.sleep(2)
        held = fds_on(fppd.proc.pid, pty.device)
        assert not held, f"fppd still holds {pty.device} open (fds {held}) after the output failed"


def test_control_channel_preset_does_not_stall_output(fppd):
    """A control channel whose preset is slow (a URL to a server that never
    answers) fires it without holding up the other outputs.

    Regression: 7c05ae3bf. The control channel output ran its presets inline
    from SendData(), on the output thread with outputThreadLock held, so
    every output stopped for as long as the preset's commands took.
    """
    import socket
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)  # accepts, never answers
    port = srv.getsockname()[1]
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ControlChannel", "enabled": 1, "startChannel": CHANNELS + 1, "channelCount": 1,
        "values": [{"value": 100, "preset": "Slow"}]}]})
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "Slow", "command": "URL", "presetSlot": 0,
        "args": [f"http://127.0.0.1:{port}/hang", "GET", ""]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    try:
        with DdpReceiver(CHANNELS) as rx:
            fppd.start()
            range_on(fppd, CHANNELS, 7)
            fppd.wait_for(lambda: rx.last() is not None and rx.last()[0] == 7, timeout=10,
                          what="output to start")
            since = time.monotonic()
            fppd.request("PUT", f"/overlays/range/{CHANNELS + 1}-{CHANNELS + 1}", {"Value": 100})
            time.sleep(3)
            times = [t for t, _ in rx.snapshot(since=since)]
        gaps = [b - a for a, b in zip(times, times[1:])]
        assert gaps and max(gaps) < 0.4, \
            f"output stalled {max(gaps) * 1000:.0f} ms while the preset ran" if gaps else "no frames"
    finally:
        srv.close()


def e131_universes(count, address="127.0.0.1", **extra):
    entry = {"active": 1, "description": "big controller", "id": 1, "startChannel": 1,
             "channelCount": 510, "type": 0, "address": address, "priority": 0,
             "monitor": 0, "deDuplicate": 0, "universeCount": count}
    entry.update(extra)
    return {"channelOutputs": [{"type": "universes", "enabled": 1, "startChannel": 1,
                                "channelCount": count * 510, "universes": [entry]}]}


def test_destination_slower_than_the_frame_rate(fppd):
    """A destination whose frame takes longer to send than the output waits
    (here 1500 universes of E1.31, which a sanitizer build sends slowly) keeps
    getting whole frames, and the rest of the show keeps running.

    Regression: b95acec2f (verify with --flavor tsan). When SendData() stopped
    waiting for a slow destination after 50 ms, the next frame's PrepData()
    rewrote that destination's headers, iovecs and dedup copy while the
    worker was still sending them. On the wire that is packets carrying half
    of one frame. Only a TSan build sends this slowly in a container: there
    the parent reported the race in 3 of 3 runs, the fix in 0 of 2.
    """
    count = 1500
    fppd.write("config/co-universes.json", e131_universes(count))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    for value in (10, 20, 30, 40):
        fppd.request("PUT", f"/overlays/range/1-{count * 510}", {"Value": value})
        time.sleep(2.5)
    fppd.request("PUT", "/overlays/range/1-1", {"deleteAll": True})


VD_PORT = 32328
B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/"


def virtual_display(fppd, map_lines, channels):
    fppd.write("config/virtualdisplaymap", "\n".join(map_lines) + "\n")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "HTTPVirtualDisplay", "enabled": 1, "startChannel": 1,
        "channelCount": channels, "width": -1, "height": -1, "pixelSize": 1,
        "colorOrder": "RGB", "port": VD_PORT}]})


def sse_messages(seconds, port=VD_PORT):
    """The color:location data lines the display streams in `seconds`."""
    import socket
    s = socket.create_connection(("127.0.0.1", port), timeout=2)
    s.settimeout(0.2)
    data = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            chunk = s.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        data += chunk
    s.close()
    return [l[len("data: "):] for l in data.decode(errors="replace").splitlines()
            if l.startswith("data: ") and len(l) > len("data: ")]


def wait_for_display(fppd, port=VD_PORT):
    import socket
    def up():
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
            return True
        except OSError:
            return False
    fppd.wait_for(up, timeout=10, what="the virtual display's port")


def test_virtual_display_shows_rgbw_pixels_with_white_off(fppd):
    """An RGBW pixel whose white channel is 0 shows its RGB colour on the
    HTTP virtual display.

    Regression: 10691010c. GetPixelRGB() only decoded the six RGB orders,
    and xLights writes "RGBW" for every RGBW model, so with W at 0 the pixel
    got no colour at all (uninitialised, or the previous pixel's).
    """
    virtual_display(fppd, ["100,100", "2,2,0,4,RGBW"], 4)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
    want = B64[200 >> 2] * 3   # RGB666 in base64, one character a channel
    msgs = sse_messages(3)
    assert any(m.startswith(want + ":") for m in msgs), f"no {want!r} pixel in {msgs[-3:]}"


def test_virtual_display_clients_join_while_frames_flow(fppd):
    """Preview clients connect, one after another, to a large HTTP virtual
    display while a test pattern streams to another client, and each new
    client is sent every pixel.

    Regression: 0ec85d6ae (verify with --flavor tsan). The connection thread
    zeroed the display's frame cache for each new client while the output
    thread was diffing the frame against it and rolling it back, with no
    lock between them: a data race, and a frame could leave the new client
    without pixels until they next changed. A display this size makes each
    frame's diff long enough that the clients land inside one. The pattern
    changes every pixel each cycle, so the full-frame check is a sanity
    check; the race is what the TSan build reports.
    """
    import socket
    pixels = 10000
    virtual_display(fppd, ["100,100"] + [f"{i % 100},{i // 100},{i * 3},3,RGB"
                                         for i in range(pixels)], pixels * 3)
    fppd.start()
    wait_for_display(fppd)
    fppd.command("Test Start", "100", "RGB Cycle", f"1-{pixels * 3}", "R-G-B")

    def full_frame(sock, seconds=10):
        """Whether `sock` is sent a frame holding every pixel: all one
        colour, so one colour group with all of their locations."""
        sock.settimeout(0.2)
        buf = b""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                chunk = sock.recv(1 << 20)
            except socket.timeout:
                continue
            if not chunk:
                return False
            buf += chunk
            lines = buf.split(b"\n")
            buf = lines.pop()
            if any(l.startswith(b"data: ") and l.count(b";") == pixels - 1 for l in lines):
                return True
        return False

    watcher = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
    try:
        assert full_frame(watcher), "the test pattern never reached the display"
        watcher.setblocking(False)
        for n in range(20):
            try:
                while watcher.recv(1 << 20):
                    pass
            except BlockingIOError:
                pass
            client = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
            try:
                assert full_frame(client), f"client {n} was never sent every pixel"
            finally:
                client.close()
    finally:
        watcher.close()
        fppd.command("Test Stop")


def test_virtual_display_pixel_at_x_4095_uses_the_pages_key(fppd):
    """A pixel at x 4095 is sent with the short location key, the form the
    page's scaleMap uses below 4096.

    Regression: c34ed8e39. The display switched to the long key at x >= 4095
    and never for y, while the page switches at x >= 4096 || y >= 4096; the
    page found no entry for such a pixel and dropped the rest of the frame.
    """
    virtual_display(fppd, ["5000,100", "4095,50,0,3,RGB"], 3)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
    msgs = [m for m in sse_messages(3) if ":" in m]
    assert msgs, "no pixel data streamed"
    loc = msgs[-1].split(":", 1)[1].split(";")[0].split("|")[0]
    assert len(loc) == 4 and loc[:2] == B64[4095 >> 6] + B64[4095 & 63], \
        f"x 4095 sent as {loc!r}, want the short key"


def test_virtual_display_closes_reset_connections(fppd):
    """Preview clients that reset their connection don't leave sockets
    open in fppd.

    Regression: c34ed8e39. A connection whose recv() failed (a client reset)
    was dropped from the list without being closed, leaking its descriptor
    and leaving the socket half open, on every reset. Only the select
    thread's recv() leaked, and it watches a client only once its 1 s
    select timeout has rebuilt the fd set, so each client is held 1.2 s.
    """
    import socket
    import struct
    virtual_display(fppd, ["100,100", "2,2,0,3,RGB"], 3)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 100})

    def sockets():
        n = 0
        for fd in os.listdir(f"/proc/{fppd.proc.pid}/fd"):
            try:
                if os.readlink(f"/proc/{fppd.proc.pid}/fd/{fd}").startswith("socket:"):
                    n += 1
            except OSError:
                pass
        return n

    time.sleep(1)
    before = sockets()
    for _ in range(5):
        c = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
        # Longer than the select thread's 1 s timeout, so it has rebuilt its
        # fd set with this client and sees the reset arrive.
        time.sleep(1.2)
        c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        c.close()  # RST
    time.sleep(2)
    after = sockets()
    assert after <= before + 1, f"fppd holds {after - before} more sockets after 5 reset clients"



@pytest.mark.parametrize("bad", [
    {"startChannel": 0, "channelCount": 10, "universeCount": 1},
    {"startChannel": 1, "channelCount": 1000000, "universeCount": 2200},
], ids=["start channel 0", "universe count overflows an int"])
def test_universe_outside_the_channel_buffer_is_refused(fppd, bad):
    """An E1.31 universe whose channels fall outside the channel buffer is
    refused with a warning, and the DDP output next to it still sends.

    Regression: 1e3aab7eb. A universe at start channel 0 reported a range
    starting at -1, which the range check let through (it only looked past
    the end), and read channelData[-1] each frame.  channelCount *
    universeCount is worked out in an int, and a large count overflowed it
    into the inverted "nothing to send" range, also let through.
    """
    cfg = ddp_output(CHANNELS)
    entry = {"active": 1, "description": "bad universe", "id": 1, "type": 1,
             "address": "127.0.0.2", "priority": 0, "monitor": 0, "deDuplicate": 0}
    entry.update(bad)
    cfg["channelOutputs"][0]["universes"].append(entry)
    fppd.write("config/co-universes.json", cfg)
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.wait_for(lambda: any("bad universe" in w and "Output disabled" in w
                                  for w in warnings(fppd)),
                      timeout=10, what="the refused-universe warning")
        range_on(fppd, 10, 42)
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the DDP output to keep sending")


def test_virtual_display_skips_a_pixel_outside_the_channel_buffer(fppd):
    """A virtual display map line naming a channel outside the channel
    buffer is skipped; the display streams its other pixels and fppd lives.

    Regression: c5839dabc. The map's channels were never checked:
    GetPixelRGB() read channelData[ch] for each, and the range reported for
    the display lost a pixel whose ch + 3 overflowed an int, so nothing
    refused it.  Its parent faults on the first frame.
    """
    virtual_display(fppd, ["100,100", "2,2,0,3,RGB", "4,4,2147483000,3,RGB"], 3)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
    want = B64[200 >> 2] * 3
    msgs = sse_messages(3)
    assert any(m.startswith(want + ":") for m in msgs), f"no {want!r} pixel in {msgs[-3:]}"
    assert fppd.get("/fppd/status")["status_name"]


def test_virtual_display_with_an_empty_map_is_refused(fppd):
    """An HTTP virtual display whose map file holds no header line (only a
    comment) is refused with a warning, and fppd starts and stays up.

    Regression: 8b6b4e36f. InitializePixelMap() succeeded without
    allocating anything, the screen size came out as (-1) * (-1) * 3, and
    Init() then zeroed 3 bytes at a null buffer: fppd died at startup, and
    again at every start after, since the config stays.
    """
    fppd.write("config/virtualdisplaymap", "# nothing mapped yet\n")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "HTTPVirtualDisplay", "enabled": 1, "startChannel": 1,
        "channelCount": 3, "width": -1, "height": -1, "pixelSize": 1,
        "colorOrder": "RGB", "port": VD_PORT}]})
    fppd.start()
    fppd.wait_for(lambda: any("could not initialize pixel map" in w for w in warnings(fppd)),
                  timeout=10, what="the could-not-initialize warning")
    range_on(fppd, 3, 200)
    time.sleep(2)


@pytest.mark.parametrize("low, high", [(100000, 50000), (100000, -100)],
                         ids=["inverted", "negative end"])
def test_an_output_reporting_a_bad_range_is_ignored(fppd, low, high):
    """A plugin output that reports an inverted channel range, or one
    ending at a negative channel, has that range ignored with an error, and
    a sequence plays, stops and plays again on the DDP output beside it.

    Regression: 9d535e473. Range lengths are max - min + 1 in unsigned
    arithmetic, so either range went into the read list about 4 GB long,
    and the output thread's first blanking of the sequence buffer memset()
    that far from channel 100001: fppd died as it started.
    """
    from native_plugin import install as install_plugin
    from show import install
    install(fppd, [bytes([9] * 30)] * 200)
    install_plugin(fppd, name="fpp-range", source="rangeoutputplugin.cpp")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "fpp-range", "enabled": 1, "startChannel": 100001, "channelCount": 10,
        "rangeMin": low, "rangeMax": high}]})
    with DdpReceiver(30) as rx:
        fppd.start()
        fppd.wait_for(lambda: "Calling Init() on fpp-range output" in fppd.log(),
                      timeout=10, what="the plugin's output to load")
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: rx.last() == bytes([9] * 30), timeout=10,
                      what="the sequence on the DDP output")
        fppd.command("Stop Now")
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "idle",
                      timeout=10, what="the playlist to stop")
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      timeout=10, what="the playlist to play again")
    assert "Ignoring invalid channel range" in fppd.log(), "no error for the bad range"


def test_virtual_display_skips_a_short_custom_colour(fppd):
    """A map line whose custom colour is not a whole "#RRGGBB" is skipped;
    the display opens its port and streams the other pixels.

    Regression: 8b6b4e36f. std::stoi() of the short colour threw out of
    Init(); the loader caught it, so fppd lived, but the display never
    opened its port.
    """
    virtual_display(fppd, ["100,100", "2,2,0,3,RGB", "4,4,3,3,#12"], 6)
    fppd.start()
    wait_for_display(fppd)
    fppd.request("PUT", "/overlays/range/1-3", {"Value": 200})
    want = B64[200 >> 2] * 3
    msgs = sse_messages(3)
    assert any(m.startswith(want + ":") for m in msgs), f"no {want!r} pixel in {msgs[-3:]}"


def ddp_and_preview(fppd, pixels=50):
    """A DDP output to a DdpReceiver and an HTTP virtual display of
    `pixels` pixels over the same channels."""
    fppd.write("config/co-universes.json", ddp_output(pixels * 3))
    virtual_display(fppd, ["100,100"] + [f"{i % 10 * 10},{i // 10 * 10},{i * 3},3,RGB"
                                         for i in range(pixels)], pixels * 3)
    fppd.settings(DisableFakeNetworkBridges="1")


def test_a_trickling_preview_client_does_not_hold_up_output(fppd):
    """A virtual display preview client that takes a frame a few bytes at a
    time doesn't hold up the other outputs: DDP keeps its frame rate.

    co_sseclient.so makes every write to the preview client take at most
    16 bytes, with an EAGAIN and a 50 ms poll between, which a real slow
    reader never produces (its frames are skipped whole).

    Regression: 2504cf877. A client part way through a chunk was waited for
    with poll(250 ms) for as long as each poll made progress, on the output
    thread with outputThreadLock held: about a second a frame here, and
    every output stopped with it.
    """
    import socket
    import shims
    ddp_and_preview(fppd)
    with DdpReceiver(150) as rx:
        fppd.start(preload=[shims.build("co_sseclient.c")],
                   extra_env={"CO_SSE_PORT": str(VD_PORT), "CO_SSE_MODE": "trickle"})
        wait_for_display(fppd)
        fppd.command("Test Start", "100", "RGB Cycle", "1-150", "R-G-B")
        assert rx.wait_frames(10, timeout=10), "no DDP frames"
        client = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
        try:
            time.sleep(1)
            since = time.monotonic()
            time.sleep(5)
            times = [t for t, _ in rx.snapshot(since)]
        finally:
            client.close()
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps and max(gaps) < 0.3, \
        f"DDP stalled {max(gaps) * 1000:.0f} ms behind the slow client" if gaps else "no DDP frames"


def test_a_preview_client_that_takes_nothing_is_dropped(fppd):
    """A virtual display preview client that never takes a byte is closed
    after a few seconds, instead of being kept, and resynced, forever.

    Regression: 2504cf877. A client whose every write failed with EAGAIN at
    byte 0 had each frame dropped and was never closed.
    """
    import socket
    import shims
    ddp_and_preview(fppd)
    with DdpReceiver(150):
        fppd.start(preload=[shims.build("co_sseclient.c")],
                   extra_env={"CO_SSE_PORT": str(VD_PORT), "CO_SSE_MODE": "stall"})
        wait_for_display(fppd)
        fppd.command("Test Start", "100", "RGB Cycle", "1-150", "R-G-B")
        client = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
        client.settimeout(1)
        closed = False
        deadline = time.monotonic() + 20
        try:
            while time.monotonic() < deadline and not closed:
                try:
                    closed = client.recv(65536) == b""
                except socket.timeout:
                    pass
                except ConnectionError:
                    closed = True
        finally:
            client.close()
    assert closed, "fppd kept a client that took nothing for 20 s"


def twinkly_near_the_top(fppd, last):
    """co-universes.json: a DDP output to the receiver, and a Twinkly of
    1800 channels (two 900-channel ports) whose last channel is `last`."""
    cfg = ddp_output(CHANNELS)
    cfg["channelOutputs"][0]["channelCount"] = 8388608
    cfg["channelOutputs"][0]["universes"].append({
        "active": 1, "description": "twinkly", "id": 0, "startChannel": last - 1800 + 1,
        "channelCount": 1800, "type": 8, "address": "192.0.2.8", "priority": 0,
        "monitor": 0, "deDuplicate": 0})
    fppd.write("config/co-universes.json", cfg)
    fppd.settings(DisableFakeNetworkBridges="1")


def ddp_still_sends(fppd):
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        range_on(fppd, 10, 42)
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the DDP output to send")
    disabled = [w for w in warnings(fppd) if "Output disabled" in w]
    assert not disabled, f"outputs disabled: {disabled}"


def test_twinkly_near_the_top_of_the_channel_buffer_keeps_the_udp_outputs(fppd):
    """A Twinkly whose 1800 channels (two 900-channel ports) end one
    channel below the top of the channel buffer loads, and the DDP output
    next to it keeps sending, with no output-disabled warning.

    Regression: 346a43e7e. Twinkly reported its range as its channel count
    times its port count (1800 x 2 here), so the loader's range check failed
    the whole UDP output and the DDP controller went dark.
    """
    twinkly_near_the_top(fppd, 8388607)
    ddp_still_sends(fppd)


def warning_ids(fppd, wid):
    return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])
            if w.get("id") == wid]


def test_removing_an_unreachable_controller_takes_its_warning_down(fppd):
    """A controller that never answers raises the unreachable-controller
    warning (27); saving the outputs without it takes the warning down.

    Regression: a45599933. Close() never removed warning 27, and the
    replacement output, which no longer pings that controller, never would:
    the banner for a controller no longer in the config stayed until fppd
    restarted.
    """
    cfg = ddp_output(CHANNELS, address="10.77.0.2")   # nothing answers here
    cfg["channelOutputs"][0]["universes"][0]["monitor"] = 1
    fppd.write("config/co-universes.json", cfg)
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: warning_ids(fppd, 27), timeout=120, interval=1,
                  what="the unreachable-controller warning")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.2"))
    fppd.wait_for(lambda: not warning_ids(fppd, 27), timeout=15, interval=0.5,
                  what="the warning to come down once the controller is gone")


def test_fixing_the_output_takes_the_local_drop_warning_down(fppd):
    """An output whose interface drops packets in its qdisc (ethfpp0, a
    dummy with a tbf qdisc too small for a frame) raises the local-drop
    warning (69) at the second stats check; saving the outputs to send
    elsewhere takes it down.

    Regression: a45599933. The warning was removed only by a later clean
    check of the same output instance; a reload replaced it with one that
    starts out not knowing the warning is up, so the banner stayed until
    fppd restarted.
    """
    import subprocess

    def run(*cmd):
        return subprocess.run(cmd, capture_output=True, text=True)

    run("ip", "link", "del", "ethfpp0")
    if run("ip", "link", "add", "ethfpp0", "type", "dummy").returncode:
        pytest.skip("cannot add a dummy interface")
    try:
        run("ip", "addr", "add", "10.66.0.1/24", "dev", "ethfpp0")
        run("ip", "link", "set", "ethfpp0", "up")
        r = run("tc", "qdisc", "add", "dev", "ethfpp0", "root", "tbf", "rate", "1mbit",
                "burst", "2kb", "limit", "3kb")
        if r.returncode:
            pytest.skip(f"tbf: {r.stderr.strip()}")
        cfg = e131_universes(20, address="10.66.0.2", type=1)
        cfg["channelOutputs"][0].update({"interface": "ethfpp0", "pacingRate": 0})
        fppd.write("config/co-universes.json", cfg)
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-10200", "R-G-B")
        fppd.wait_for(lambda: warning_ids(fppd, 69), timeout=240, interval=2,
                      what="the local-drop warning")
        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.2"))
        fppd.wait_for(lambda: not warning_ids(fppd, 69), timeout=15, interval=0.5,
                      what="the local-drop warning to come down after the save")
    finally:
        run("ip", "link", "del", "ethfpp0")


def test_the_local_drop_warning_has_its_own_id_and_help(fppd):
    """An output whose interface drops packets in its qdisc raises the
    local-drop warning as id 69, and the definition the web UI looks that id
    up in (www/warnings-definitions.json, by id, as updateWarnings() in
    js/fpp.js does) gives it the drop banner's title and a help page that
    exists.

    Regression: ff211d104. The drop banner was raised as warning 57, the
    plugin-reinstall warning's id, so the UI showed it with "plugins must be
    reinstalled" as its title and linked to the plugin help.
    """
    import subprocess

    def run(*cmd):
        return subprocess.run(cmd, capture_output=True, text=True)

    run("ip", "link", "del", "ethfpp0")
    if run("ip", "link", "add", "ethfpp0", "type", "dummy").returncode:
        pytest.skip("cannot add a dummy interface")
    try:
        run("ip", "addr", "add", "10.66.0.1/24", "dev", "ethfpp0")
        run("ip", "link", "set", "ethfpp0", "up")
        r = run("tc", "qdisc", "add", "dev", "ethfpp0", "root", "tbf", "rate", "1mbit",
                "burst", "2kb", "limit", "3kb")
        if r.returncode:
            pytest.skip(f"tbf: {r.stderr.strip()}")
        cfg = e131_universes(20, address="10.66.0.2", type=1)
        cfg["channelOutputs"][0].update({"interface": "ethfpp0", "pacingRate": 0})
        fppd.write("config/co-universes.json", cfg)
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-10200", "R-G-B")

        def drop_warning():
            return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                    if "dropping outgoing packets" in w.get("message", "")]
        up = fppd.wait_for(drop_warning, timeout=240, interval=2, what="the local-drop warning")
        ids = sorted({w.get("id") for w in up})
        assert ids == [69], f"the local-drop warning was raised as id {ids}, not 69"

        tree = os.environ["FPP_TREE"]
        with open(os.path.join(tree, "www/warnings-definitions.json")) as f:
            defs = [d for d in json.load(f)["Warnings"] if d["id"] == 69]
        assert len(defs) == 1, f"warnings-definitions.json has {len(defs)} entries for id 69"
        assert "Dropping Packets" in defs[0]["Title"], defs[0]
        assert defs[0]["HelpPageType"] == "md", defs[0]
        assert os.path.isfile(os.path.join(tree, "www/help/warning-helpers/warning-69.md"))
    finally:
        run("ip", "link", "del", "ethfpp0")


def test_an_output_type_with_a_percent_is_logged_as_it_is(fppd):
    """An output type fppd has no plugin for is logged by name, '%'
    characters and all.

    Regression: 152d19dc9. The loader passed the warning it had built as
    the printf format of LogErr(), so "%d%d%x" in a type name was replaced
    by whatever the missing arguments' registers held. (%d rather than %s,
    so the parent prints garbage instead of faulting: the red is the
    assertion.)
    """
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "Bogus%d%d%x", "enabled": 1, "startChannel": 1, "channelCount": 3}]})
    fppd.start()
    fppd.wait_for(lambda: "Bogus" in fppd.log(), timeout=10, what="the loader to log the type")
    line = [l for l in fppd.log().splitlines() if "Could not create output type" in l]
    assert line, "no could-not-create line logged"
    assert "Could not create output type Bogus%d%d%x" in line[0], line[0]


def model_pixel_strings(port):
    """A 10x5 overlay model and a ModelPixelStrings output drawing one
    10-pixel string on it, from the string's port `port`."""
    return ({"autoCreate": False, "models": [{
        "Name": "M", "Type": "Channel", "StartChannel": 1, "ChannelCount": 150,
        "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
        "StringCount": 5, "StrandsPerString": 1}]},
        {"channelOutputs": [{
            "type": "ModelPixelStrings", "enabled": 1, "startChannel": 1001, "channelCount": 30,
            "modelName": "M", "outputs": [{
                "portNumber": port, "protocol": "ws2811", "virtualStrings": [{
                    "description": "s", "startChannel": 1000, "pixelCount": 10, "groupCount": 0,
                    "reverse": 0, "colorOrder": "RGB", "nullNodes": 0, "endNulls": 0,
                    "zigZag": 0, "brightness": 100, "gamma": "1.0"}]}]}]})


@pytest.mark.parametrize("port", [0, -1], ids=["port 0", "port -1"])
def test_a_pixel_string_with_a_negative_port_number_is_refused(fppd, port):
    """A pixel string whose port number is negative is refused when its
    output is set up; port 0 is a string like any other. The PRU string
    drivers index per-port arrays by it (smart receiver packets among
    them), so a negative one wrote outside them.

    Regression: 2fdf7e617. Any port number was accepted. This checks the
    guard in PixelString, which every string driver shares; the overflow
    itself is in the BeagleBone drivers, out of reach here.
    """
    models, outputs = model_pixel_strings(port)
    fppd.write("config/model-overlays.json", models)
    fppd.write("config/co-pixelStrings.json", outputs)
    # "Configured <type> Channel Output" is logged at debug level
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="debug")
    fppd.start()
    failed = any("Could not initialize output type ModelPixelStrings" in w for w in warnings(fppd))
    if port < 0:
        assert failed, warnings(fppd)
        assert "invalid port number -1" in fppd.log()
    else:
        assert not failed, warnings(fppd)
        assert "Configured ModelPixelStrings" in fppd.log(), fppd.log()[-3000:]


@pytest.mark.parametrize("kind", ["twinkly", "ddp"])
def test_a_network_output_ending_on_the_last_channel_keeps_the_udp_outputs(fppd, kind):
    """A network output whose channels end exactly on the last channel of
    the buffer (8388608) loads, and the DDP output next to it keeps sending:
    a Twinkly of 1800 channels, or a DDP output of 150.

    Regression: 6c9e45efa. Every UDPOutputData reported its range with max
    one past its last channel (startChannel + channelCount - 1 from a 1-based
    start), and UDPOutput handed that on as the inclusive last channel the
    loader expects. fppd logged "needs channels 8386809-8388609, outside
    1-8388608. Output disabled." and every UDP output went dark.
    """
    if kind == "twinkly":
        twinkly_near_the_top(fppd, 8388608)
    else:
        cfg = ddp_output(CHANNELS)
        cfg["channelOutputs"][0]["channelCount"] = 8388608
        cfg["channelOutputs"][0]["universes"].append({
            "active": 1, "description": "top", "id": 0, "startChannel": 8388608 - CHANNELS + 1,
            "channelCount": CHANNELS, "type": 5, "address": "192.0.2.9", "priority": 0,
            "monitor": 0, "deDuplicate": 0})
        fppd.write("config/co-universes.json", cfg)
        fppd.settings(DisableFakeNetworkBridges="1")
    ddp_still_sends(fppd)


@pytest.mark.parametrize("pin", [{"pin": "P9-99"}, {"gpio": 9999}], ids=["by-name", "by-number"])
def test_disabling_a_gpio_output_on_a_missing_pin_takes_its_warning_down(fppd, pin):
    """A GPIO output naming a pin this board doesn't have raises warning 51;
    saving the output disabled takes the warning down.

    Regression: 9806ee594. GPIOOutput::Init() raised "GPIO Pin '...' not found"
    with a plain AddWarning() that nothing removed, so the banner outlived
    the config that caused it until fppd restarted.
    """
    def gpio(enabled):
        return {"channelOutputs": [dict({
            "type": "GPIO", "enabled": enabled, "startChannel": 1, "channelCount": 1,
            "invert": 0, "pwm": 0}, **pin)]}

    fppd.write("config/co-other.json", gpio(1))
    fppd.start()
    fppd.wait_for(lambda: warning_ids(fppd, 51), timeout=10, what="the pin-not-found warning")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-other.json", gpio(0))
    fppd.wait_for(lambda: not warning_ids(fppd, 51), timeout=15, interval=0.5,
                  what=f"the pin-not-found warning to come down (still: {warning_ids(fppd, 51)})")


def test_fixing_a_dmx_output_wider_than_a_universe_takes_its_warning_down(fppd):
    """A DMX-Pro output of 600 channels is cut to 512 with a warning; saving
    it at 512 takes the warning down.

    Regression: 9806ee594. The warning is raised from the output's
    constructor with a plain AddWarning(), and the loader collected an
    output's config warnings only around Init(), so it stayed up until fppd
    restarted.
    """
    def dmx(count):
        return {"channelOutputs": [{
            "type": "DMX-Pro", "enabled": 1, "startChannel": 1, "channelCount": count,
            "device": "ttyUSB99"}]}

    def wide():
        return [w for w in warnings(fppd) if "exceeds the DMX universe size" in w]

    fppd.write("config/co-other.json", dmx(600))
    fppd.start()
    fppd.wait_for(wide, timeout=10, what="the channel-count warning")
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-other.json", dmx(512))
    fppd.wait_for(lambda: not wide(), timeout=15, interval=0.5,
                  what=f"the channel-count warning to come down (still: {wide()})")


def save_in_place(path, content, gap=0.3):
    """Save a file the way a script or a plugin does, over the old one: an
    open with O_TRUNC, then the content in two writes, then a close. Each
    step is `gap` apart, so fppd has read one inotify event before the next
    arrives (the kernel merges identical events still queued)."""
    data = json.dumps(content, indent=4).encode()
    fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
    try:
        time.sleep(gap)
        os.write(fd, data[:len(data) // 2])
        time.sleep(gap)
        os.write(fd, data[len(data) // 2:])
        time.sleep(gap)
    finally:
        os.close(fd)


def test_a_save_in_place_reloads_the_outputs_once(fppd):
    """Five saves of co-other.json, each written in place (truncate, two
    writes, close), reload its outputs five times, once per save, and fppd
    never tries to read the file half written.

    Regression: 6005f8af7. FileMonitor watched with IN_MODIFY, and the
    truncate and each write are an IN_MODIFY of their own, so one save
    reloaded the outputs once per event (up to three times here, as the
    kernel merges events still queued), the first time on the empty file
    and the next on the half-written one ("Error parsing"). It now watches IN_CLOSE_WRITE: one event per save, once the
    file is complete.

    Also 812bdaab3, which made a saved Other/universe output config reload
    at runtime at all: before it the outputs were read once at startup and
    a save needed a restart (no reload for any save).
    """
    path = os.path.join(fppd.media, "config", "co-other.json")

    def udp(port):
        return {"channelOutputs": [{
            "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 10,
            "address": "127.0.0.1", "port": port, "tokens": "{data}"}]}

    def reloads():
        return sum(1 for line in fppd.log().splitlines()
                   if "Reloading Channel Outputs for " in line and line.rstrip().endswith("/co-other.json"))

    fppd.write("config/co-other.json", udp(9000))
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start()
    # fppd loads every output config once at startup through the same callback
    fppd.wait_for(lambda: reloads() >= 1, timeout=10, what="the startup load of co-other.json")
    base = reloads()
    saves = 5
    for i in range(1, saves + 1):
        save_in_place(path, udp(9000 + i))
        fppd.wait_for(lambda: reloads() >= base + i, timeout=10,
                      what=f"the reload for save {i}")
    time.sleep(2)  # room for any late, extra reload to show
    assert reloads() - base == saves, f"{reloads() - base} reloads for {saves} saves"
    parse_errors = [line for line in fppd.log().splitlines()
                    if "Error parsing" in line and "co-other.json" in line]
    assert not parse_errors, parse_errors


def test_an_output_starting_at_channel_zero_is_refused(fppd):
    """An output config with "startChannel": 0 (one-based, so channel -1)
    and channels to send is refused with a warning naming its type, and
    the outputs beside it keep sending.

    Regression: c4efe2b3f (its ChannelOutputSetup.cpp half; the BBBUtils
    half, kernel GPIO numbers, was replaced by later chip mapping). The
    loader took the -1 as the output's offset into the channel buffer, so
    the output read from before the buffer on every frame.
    """
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericUDP", "enabled": 1, "startChannel": 0, "channelCount": 10,
        "address": "127.0.0.1", "port": 9999, "tokens": "{data}"}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        range_on(fppd, 10, 42)
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the good output to send")
    w = warnings(fppd)
    assert "Could not initialize output type GenericUDP. Invalid start channel." in w, w
    assert "Calling Init() on GenericUDP" not in fppd.log(), fppd.tail()
