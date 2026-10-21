"""WLED audio sync: fppd listens for the audio-sync packets other WLED
devices send (UDP, port 11988 by default) and drives its own WLED♪
sound-reactive effects from them instead of from its local audio
(WLEDAudioSyncMode=receive), or sends its own (send).

The effect watched is GEQ on a 16x5 matrix, which draws one bar per FFT band:
column x is band x, and its height is the band's value mapped onto the five
rows (map(v, 0, 255, 0, 5): 51 per row, so 51*h is exactly h rows). With the
"* Color 1" palette in red, a fade speed of 255 (everything not redrawn is
black on the next frame) and a ripple decay of 255 (the peak marker sits on
top of its bar), a steady stream of one packet gives one exact frame on the
wire: the bars, red, and nothing else. Without a recent packet the effect
falls back to its simulated sound (sine waves per band), which never holds
still -- so a frame that equals the expected bars came from the packets.

The effects run at Brightness 128, the WLED port's unity, except where
Brightness is what's tested, and with BufferMapping "Horizontal" spelled out
except where the mapping is what's tested.
"""

import socket
import struct
import subprocess
import threading
import time

from ddp import DdpReceiver
from test_overlays import effect, matrix, setup, stop_effects

W, H = 16, 5
CHANNELS = W * H * 3
PORT = 11988
# Not one of fppd's own addresses (getifaddrs lists only 127.0.0.1 on lo),
# but on the loopback network, so packets from it reach fppd.
PEER = "127.0.0.2"


def packet(fft, smth=100.0, raw=100.0, peak=0, magnitude=1000.0, major=1000.0,
           header=b"00002\0"):
    """A WLED audio-sync V2 packet, as WLED's audioreactive usermod sends it
    (audioSyncPacket, little-endian, 44 bytes): the header "00002" and a NUL,
    two pad bytes, sampleRaw and sampleSmth (floats), samplePeak, a reserved
    byte, the 16 FFT bands, two pad bytes, FFT_Magnitude and FFT_MajorPeak
    (floats)."""
    return struct.pack("<6s2xffBB16sHff", header, raw, smth, peak, 0, bytes(fft), 0,
                       magnitude, major)


def bands(heights):
    """FFT band values that GEQ draws as bars of these heights."""
    return [51 * h for h in heights]


def bars(heights):
    """The frame GEQ sends for bars of these heights: column x lit red from
    the bottom row up to heights[x], the rest black. Row-major from the top
    left, as the Horizontal mapping lays the matrix out."""
    f = bytearray(CHANNELS)
    for x, h in enumerate(heights):
        for y in range(H - h, H):
            f[(y * W + x) * 3] = 255
    return bytes(f)


STAIRS = [x % 6 for x in range(W)]           # 0,1,2,3,4,5,0,1,...
REVERSED = STAIRS[::-1]
FULL = [H] * W
SILENT = [0] * W


def show(frame):
    if frame is None:
        return "no frame"
    return "\n".join("".join("#" if any(frame[(y * W + x) * 3:(y * W + x) * 3 + 3]) else "."
                             for x in range(W)) for y in range(H))


def start_geq(fppd, mapping="Horizontal"):
    effect(fppd, "M", "WLED♪ - GEQ", BufferMapping=mapping, brightness="128",
           palette="* Color 1", color1="#FF0000", color3="#000000",
           **{"Fade speed": "255", "Ripple decay": "255", "# of bands": "255"})


def wait_frame(fppd, rx, expected, what, timeout=10):
    try:
        fppd.wait_for(lambda: rx.last() == expected, timeout=timeout, interval=0.02, what=what)
    except TimeoutError:
        raise AssertionError(f"timed out waiting for {what}; last frame:\n{show(rx.last())}\n"
                             f"expected:\n{show(expected)}")


class Stream:
    """Sends packets to fppd every 10 ms from a thread, the way a WLED
    device streams them. `send` is a list of (socket, packet, port), sent
    back to back in that order each round, and can be swapped at any time.
    A packet that should be ignored goes last: if fppd took it, it would be
    the one cached for most of each round."""

    def __init__(self):
        self.send = []
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            for sock, pkt, port in list(self.send):
                try:
                    sock.sendto(pkt, ("127.0.0.1", port))
                except OSError:
                    pass
            time.sleep(0.01)

    def close(self):
        self.running = False
        self.thread.join()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def udp_socket(src):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((src, 0))
    return s


def local_ipv4_addresses():
    """Every IPv4 address of this network namespace (fppd's too)."""
    out = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True,
                         check=True).stdout
    addrs = [line.split()[3].split("/")[0] for line in out.splitlines()]
    assert "127.0.0.1" in addrs, out
    return addrs


def udp_bound(port):
    """Whether any socket holds UDP `port` in this network namespace."""
    with open("/proc/net/udp") as f:
        next(f)
        return any(int(line.split()[1].split(":")[1], 16) == port for line in f)


def frames_since(rx, since):
    return [f for _, f in rx.snapshot(since)]


def test_audio_sync_packets_drive_a_sound_reactive_effect(fppd):
    """With WLEDAudioSyncMode=receive, the bands of the packets a WLED device
    sends are what fppd's GEQ effect draws, exactly: stairs, then the stairs
    reversed, then silence (all black) as the packets change. When they stop,
    the cached frame expires (250 ms) and the effect goes back to its own
    simulated sound."""
    setup(fppd, [matrix("M", width=W, height=H)], channels=CHANNELS)
    fppd.settings(WLEDAudioSyncMode="receive")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_geq(fppd)
        sock = udp_socket(PEER)
        try:
            with Stream() as stream:
                for heights, what in ((STAIRS, "the stairs"), (REVERSED, "the reversed stairs"),
                                      (SILENT, "silence")):
                    stream.send = [(sock, packet(bands(heights)), PORT)]
                    wait_frame(fppd, rx, bars(heights), f"{what} from the packets")
                    since = time.monotonic()
                    rx.wait_frames(10, since=since)
                    assert rx.last() == bars(heights), f"{what} did not hold:\n{show(rx.last())}"
                stream.send = []
                fppd.wait_for(lambda: rx.last() != bars(SILENT), timeout=5, interval=0.05,
                              what="the effect to go back to its simulated sound")
        finally:
            sock.close()
        stop_effects(fppd, "M")


def test_an_unknown_buffer_mapping_draws_as_horizontal(fppd):
    """A BufferMapping that names no mapping (empty, or the wrong case) draws
    a 2D effect as Horizontal does: GEQ's stairs come out as 16 bars on the
    16x5 matrix. Each mapping gets different bands, so a frame left from the
    one before can't pass for it.

    Regression: bd192875f. The effect's segment was built transposed (5
    wide, 16 high) while its pixels were laid out as Horizontal, so the frame
    showed 5 bars, 16 rows tall, wrapped across the matrix's 5 rows."""
    setup(fppd, [matrix("M", width=W, height=H)], channels=CHANNELS)
    fppd.settings(WLEDAudioSyncMode="receive")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        sock = udp_socket(PEER)
        try:
            with Stream() as stream:
                for mapping, heights in (("", STAIRS), ("horizontal", REVERSED)):
                    stream.send = [(sock, packet(bands(heights)), PORT)]
                    start_geq(fppd, mapping)
                    wait_frame(fppd, rx, bars(heights), f"the bars with BufferMapping {mapping!r}")
        finally:
            sock.close()
        stop_effects(fppd, "M")


def test_bad_packets_are_ignored(fppd):
    """Packets that aren't V2 audio sync from another device are dropped,
    while a device's good packets keep driving the effect. Each kind is
    interleaved with good ones for a second, carrying bands that would light
    the whole matrix; no frame may come out fully lit, and the good packets'
    stairs must still be on the wire afterwards:

    - too short (43 bytes), too long (45 bytes), and empty,
    - the V1 header "00001" (in an 88-byte V1-sized packet and a 44-byte one),
      and an unknown "00003",
    - a NaN or an infinity in any of the four floats,
    - sent from one of fppd's own addresses (127.0.0.1, and the container's
      own on eth0): its own packets coming back, which it must not feed on.

    Then the same full-matrix bands in a good packet do light the matrix, so
    the check above could see them.

    Regression: 0be145b8b. A datagram longer than 44 bytes with a V2
    header was taken as a V2 packet: recvfrom into the 44-byte struct cut it
    short and returned 44. WLED drops it."""
    setup(fppd, [matrix("M", width=W, height=H)], channels=CHANNELS)
    fppd.settings(WLEDAudioSyncMode="receive")
    full = packet(bands(FULL))
    nan, inf = float("nan"), float("inf")
    bad = [
        ("43 bytes", PEER, full[:43]),
        ("45 bytes", PEER, full + b"\0"),
        ("empty", PEER, b""),
        ("V1 header, 88 bytes", PEER, packet(bands(FULL), header=b"00001\0") + bytes(44)),
        ("V1 header, 44 bytes", PEER, packet(bands(FULL), header=b"00001\0")),
        ("header 00003", PEER, packet(bands(FULL), header=b"00003\0")),
        ("NaN sampleRaw", PEER, packet(bands(FULL), raw=nan)),
        ("NaN sampleSmth", PEER, packet(bands(FULL), smth=nan)),
        ("-Inf FFT_Magnitude", PEER, packet(bands(FULL), magnitude=-inf)),
        ("Inf FFT_MajorPeak", PEER, packet(bands(FULL), major=inf)),
    ]
    bad += [(f"from fppd's own {a}", a, full) for a in local_ipv4_addresses()]
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_geq(fppd)
        good = udp_socket(PEER)
        try:
            with Stream() as stream:
                stream.send = [(good, packet(bands(STAIRS)), PORT)]
                wait_frame(fppd, rx, bars(STAIRS), "the good packets' stairs")
                for what, src, pkt in bad:
                    s = udp_socket(src)
                    try:
                        since = time.monotonic()
                        stream.send = [(good, packet(bands(STAIRS)), PORT), (s, pkt, PORT)]
                        time.sleep(1)
                        stream.send = [(good, packet(bands(STAIRS)), PORT)]
                        lit = [f for f in frames_since(rx, since) if f == bars(FULL)]
                        assert not lit, f"{what}: a packet was used ({len(lit)} full frames)"
                        assert rx.count(since) > 10, f"{what}: output stopped"
                        wait_frame(fppd, rx, bars(STAIRS), f"the stairs after {what}")
                    finally:
                        s.close()
                fppd.check_alive()
                stream.send = [(good, full, PORT)]
                wait_frame(fppd, rx, bars(FULL), "a good full-matrix packet to light it all")
        finally:
            good.close()
        stop_effects(fppd, "M")


def test_audio_sync_mode_and_port_change_while_running(fppd):
    """The WLED Audio Sync settings take effect without a restart:

    - off (the default): nothing listens on 11988, and packets there don't
      reach the effect: bands that would light the whole matrix never do;
    - receive: fppd opens the port and the packets draw their bars;
    - port 12000: 11988 is closed and packets to it no longer count, while
      ones to 12000 do: with a full matrix streamed to 11988 and stairs to
      12000, no frame is fully lit;
    - off again: the port is closed and the effect is back on its own;
    - receive with 12000 held by another program (without SO_REUSEADDR):
      fppd can't bind it, raises "could not open the receive socket" and
      stays off (packets sent there once it's free don't count); switching
      off and back to receive then listens, with no warning left."""
    setup(fppd, [matrix("M", width=W, height=H)], channels=CHANNELS)
    other = 12000
    warning = "WLED Audio Sync: could not open the receive socket"

    def warnings():
        return [w for w in fppd.get("/fppd/status").get("warnings", []) if "WLED Audio Sync" in w]

    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        start_geq(fppd)
        sock = udp_socket(PEER)
        try:
            with Stream() as stream:
                # Off: the default.
                assert not udp_bound(PORT), "something listens on 11988 with audio sync off"
                stream.send = [(sock, packet(bands(FULL)), PORT)]
                since = time.monotonic()
                time.sleep(1.5)
                assert rx.count(since) > 10, "output stopped"
                assert bars(FULL) not in frames_since(rx, since), \
                    "packets drew the effect with audio sync off"

                fppd.settings(WLEDAudioSyncMode="receive")
                wait_frame(fppd, rx, bars(FULL), "the packets' bars once receive is switched on")
                assert udp_bound(PORT)

                fppd.settings(WLEDAudioSyncPort=str(other))
                stream.send = [(sock, packet(bands(STAIRS)), other),
                               (sock, packet(bands(FULL)), PORT)]
                wait_frame(fppd, rx, bars(STAIRS), "port 12000's bars")
                assert not udp_bound(PORT), "11988 still open after the port moved"
                since = time.monotonic()
                time.sleep(1)
                assert rx.count(since) > 10, "output stopped"
                lit = [f for f in frames_since(rx, since) if f == bars(FULL)]
                assert not lit, f"packets to 11988 still drew the effect ({len(lit)} frames)"
                wait_frame(fppd, rx, bars(STAIRS), "port 12000's bars, still")

                fppd.settings(WLEDAudioSyncMode="off")
                fppd.wait_for(lambda: not udp_bound(other), what="port 12000 to close")
                fppd.wait_for(lambda: rx.last() != bars(STAIRS), timeout=5, interval=0.05,
                              what="the effect to go back to its simulated sound")
                stream.send = []

                blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                try:
                    blocker.bind(("0.0.0.0", other))
                    fppd.settings(WLEDAudioSyncMode="receive")
                    fppd.wait_for(lambda: warning in warnings(), what="the receive socket warning")
                finally:
                    blocker.close()
                assert not udp_bound(other), "fppd holds 12000 though its bind failed"
                stream.send = [(sock, packet(bands(STAIRS)), other)]
                since = time.monotonic()
                time.sleep(1)
                assert rx.count(since) > 10, "output stopped"
                assert bars(STAIRS) not in frames_since(rx, since), \
                    "packets drew the effect though the bind failed"

                fppd.settings(WLEDAudioSyncMode="off")
                fppd.settings(WLEDAudioSyncMode="receive")
                wait_frame(fppd, rx, bars(STAIRS), "the stairs once the port is free")
                assert warnings() == [], warnings()
        finally:
            sock.close()
        stop_effects(fppd, "M")


def test_out_of_range_values_are_clamped(fppd):
    """A packet's floats are clamped to what WLED itself sends before the
    effects see them: a volume (sampleSmth) of 1e30 draws exactly what 255
    does, and a major peak of 1e9 Hz exactly what 11025 Hz does.

    Watched with Freqmatrix on a 10-pixel string, which shifts one pixel
    per frame and colours the new one from the volume (brightness) and the
    major peak (hue), so a steady packet turns the whole string one colour.
    With the Sound effect slider at 64 and Sensitivity at 0, volume 255
    gives brightness 61 of 255 where an unclamped 1e30 would give 255 (and
    volume 100 gives a dimmer colour than 255, so the volume shows); a peak
    above 11025 Hz would be taken as 1 Hz, which is black."""
    n = 10
    setup(fppd, [matrix("S", width=n, height=1)], channels=n * 3)
    fppd.settings(WLEDAudioSyncMode="receive")

    def uniform_lit(f):
        return f is not None and any(f[:3]) and f == f[:3] * n

    with DdpReceiver(n * 3) as rx:
        fppd.start()
        effect(fppd, "S", "WLED♪ - Freqmatrix", BufferMapping="Horizontal", brightness="128",
               Speed="255", **{"Sound effect": "64", "Low bin": "0", "High bin": "255",
                               "Sensitivity": "0"})
        sock = udp_socket(PEER)
        try:
            with Stream() as stream:
                def steady(what, **values):
                    """The string's colour for a steady stream of these
                    values, from a black string: the first frame that is one
                    lit colour all along is the new colour, shifted in."""
                    stream.send = [(sock, packet(SILENT, major=50.0), PORT)]
                    fppd.wait_for(lambda: rx.last() == bytes(n * 3), interval=0.02,
                                  what="black from a 50 Hz peak")
                    stream.send = [(sock, packet(SILENT, **values), PORT)]
                    return fppd.wait_for(lambda: uniform_lit(rx.last()) and rx.last(),
                                         interval=0.02, what=what)

                at_255 = steady("volume 255", smth=255.0, major=1000.0)
                assert steady("volume 1e30", smth=1e30, major=1000.0) == at_255
                assert steady("volume 100", smth=100.0, major=1000.0) != at_255
                at_nyquist = steady("peak 11025 Hz", smth=255.0, major=11025.0)
                assert steady("peak 1e9 Hz", smth=255.0, major=1e9) == at_nyquist
        finally:
            sock.close()
        stop_effects(fppd, "S")


def test_brightness_scales_each_pixel_once(fppd):
    """An effect's Brightness scales its colours once, however often it reads
    its pixels back: Freqmatrix (which shifts the string one pixel a frame)
    fed a steady packet turns the 10-pixel string one colour, at Brightness
    255 the colour it has at 128 scaled by 255/128, and at 64 by a half.

    Regression: 73015d126. The bus returned the scaled colour when a pixel
    was read back, so each shift scaled it again: at 255 every pixel came out
    twice the one before, and at 64 half."""
    n = 10
    setup(fppd, [matrix("S", width=n, height=1)], channels=n * 3)
    fppd.settings(WLEDAudioSyncMode="receive")

    def start(brightness):
        effect(fppd, "S", "WLED♪ - Freqmatrix", BufferMapping="Horizontal",
               brightness=str(brightness), Speed="255",
               **{"Sound effect": "64", "Low bin": "0", "High bin": "255", "Sensitivity": "0"})

    with DdpReceiver(n * 3) as rx:
        fppd.start()
        sock = udp_socket(PEER)
        try:
            with Stream() as stream:
                stream.send = [(sock, packet(SILENT, smth=255.0, major=1000.0), PORT)]
                start(128)
                frame = fppd.wait_for(
                    lambda: (f := rx.last()) is not None and any(f[:3]) and f == f[:3] * n and f,
                    interval=0.02, what="one colour all along at Brightness 128")
                colour = frame[:3]
                for brightness in (255, 64):
                    want = bytes(min(v * brightness // 128, 255) for v in colour) * n
                    start(brightness)
                    try:
                        fppd.wait_for(lambda: rx.last() == want, interval=0.02,
                                      what=f"Brightness {brightness}")
                    except TimeoutError:
                        raise AssertionError(f"Brightness {brightness}: wanted {list(want[:3])} "
                                             f"all along, got {list(rx.last())}")
        finally:
            sock.close()
        stop_effects(fppd, "S")


def test_send_mode_with_a_destination_that_is_not_an_address(fppd):
    """Send mode with a WLEDAudioSyncDest that isn't an IPv4 address raises
    "invalid destination address" (fppd keeps running); setting a valid one
    while running clears the warning, and switching to receive leaves no
    WLED Audio Sync warning either."""
    warning = "WLED Audio Sync: invalid destination address"

    def warnings():
        return [w for w in fppd.get("/fppd/status").get("warnings", []) if "WLED Audio Sync" in w]

    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="wled.invalid")
    fppd.start()
    fppd.wait_for(lambda: warning in warnings(), what="the invalid destination warning")
    assert warnings() == [warning], warnings()
    fppd.settings(WLEDAudioSyncDest="127.0.0.1")
    fppd.wait_for(lambda: warnings() == [], what="the warning to clear")
    fppd.settings(WLEDAudioSyncDest="300.1.2.3")
    fppd.wait_for(lambda: warning in warnings(), what="the warning for 300.1.2.3")
    fppd.settings(WLEDAudioSyncMode="receive")
    fppd.wait_for(lambda: warnings() == [], what="the warning to clear in receive mode")
    assert udp_bound(PORT)


def test_send_mode_and_a_sound_reactive_effect_share_the_sound_source(fppd):
    """In send mode the audio sync thread pulls samples from the WLED sound
    source while a sound-reactive effect pulls from it on the effect
    thread; both keep running.

    Regression: f2f871695, under TSan; proved by reverting it on 0ec85d6ae,
    since its parent has other races. The source opened
    its capture and filled its sample buffer for whichever thread called
    first, with no lock, so the two threads' first calls raced: two
    pipelines opened (one leaked) and both wrote the buffer at once.
    """
    setup(fppd, [matrix("M", width=W, height=H)], channels=CHANNELS)
    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        time.sleep(1)  # the sync thread is pulling samples by now
        start_geq(fppd)
        fppd.wait_for(lambda: any(rx.last() or b""), timeout=10, interval=0.05,
                      what="the effect to draw")
        time.sleep(2)
        stop_effects(fppd, "M")
