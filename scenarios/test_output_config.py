"""Channel output configs fppd can only partly use, warnings that must come
down with a fix, and serial outputs written into a pty."""

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

    Regression: b95acec2f. When SendData() stopped
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


def sse_messages(seconds):
    """The color:location data lines the display streams in `seconds`."""
    import socket
    s = socket.create_connection(("127.0.0.1", VD_PORT), timeout=2)
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


def wait_for_display(fppd):
    import socket
    def up():
        try:
            socket.create_connection(("127.0.0.1", VD_PORT), timeout=1).close()
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
    and leaving the socket half open, on every reset.
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
        time.sleep(0.3)
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
