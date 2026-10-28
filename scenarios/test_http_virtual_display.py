"""The HTTP virtual display (HTTPVirtualDisplay) and the lights it shares an
output thread with: a preview client is not allowed to hold up the show."""

import socket
import time

from ddp import DdpReceiver
from show import ddp_output
from test_output_config import virtual_display, wait_for_display, VD_PORT

PIXELS = 10000
CHANNELS = PIXELS * 3


def frames_in(rx, start, end):
    with rx.lock:
        return sum(1 for t, _ in rx.frames if start <= t < end)


def test_a_preview_client_that_stops_reading_does_not_stall_the_lights(fppd):
    """A browser that connects to a large virtual display and then stops
    reading its socket: the DDP output fed by the same output thread keeps
    sending at its rate, and the display keeps serving a client that does
    read.

    Regression: b59c62f81. Accepted connections did not inherit the
    listener's O_NONBLOCK and WriteSSEPacket() wrote with a plain blocking
    write(), so once the stalled client's socket buffers filled, write()
    blocked the channel output thread: every output stopped, the lights
    along with the preview, until the browser read again or went away."""
    virtual_display(fppd, ["100,100"] + [f"{i % 100},{i // 100},{i * 3},3,RGB"
                                         for i in range(PIXELS)], CHANNELS)
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        wait_for_display(fppd)
        fppd.command("Test Start", "100", "RGB Cycle", f"1-{CHANNELS}", "R-G-B")
        time.sleep(3)
        now = time.monotonic()
        before = frames_in(rx, now - 2, now)
        assert before >= 10, f"only {before} DDP frames in 2 s before the stalled client"

        stalled = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
        stalled.connect(("127.0.0.1", VD_PORT))
        try:
            # Frames carrying every pixel, ten a second: the stalled socket's
            # buffers on both ends fill within a second or two.
            time.sleep(8)
            now = time.monotonic()
            after = frames_in(rx, now - 2, now)
            reader = socket.create_connection(("127.0.0.1", VD_PORT), timeout=5)
            try:
                reader.settimeout(5)
                got = b""
                end = time.monotonic() + 5
                while b"data: " not in got and time.monotonic() < end:
                    try:
                        chunk = reader.recv(65536)
                    except socket.timeout:
                        break
                    if not chunk:
                        break
                    got += chunk
            finally:
                reader.close()
        finally:
            stalled.close()
            fppd.command("Test Stop")
    assert after >= before // 2, \
        f"{after} DDP frames in 2 s with a preview client not reading, {before} before it connected"
    assert b"data: " in got, "a reading client got no frame while another was stalled"


def test_preview_clients_come_and_go_while_it_streams(fppd):
    """Preview clients that connect, take a frame and hang up, one after
    another and two at a time, while the display streams a test pattern:
    each is served, and the display keeps serving the next.

    Regression (TSan): c08e4f453. The accept thread set m_connListChanged
    while the select thread read and cleared it, and both read m_running:
    volatile bools, which order nothing between threads."""
    virtual_display(fppd, ["10,10"] + [f"{i % 10},{i // 10},{i * 3},3,RGB" for i in range(100)], 300)
    fppd.start()
    wait_for_display(fppd)
    fppd.command("Test Start", "100", "RGB Cycle", "1-300", "R-G-B")
    try:
        for i in range(10):
            clients = [socket.create_connection(("127.0.0.1", VD_PORT), timeout=5)
                       for _ in range(1 + i % 2)]
            try:
                for n, s in enumerate(clients):
                    s.settimeout(5)
                    got = b""
                    end = time.monotonic() + 5
                    while b"data: " not in got and time.monotonic() < end:
                        chunk = s.recv(65536)
                        if not chunk:
                            break
                        got += chunk
                    assert b"data: " in got, f"round {i}, client {n} got no frame: {got[-200:]!r}"
            finally:
                for s in clients:
                    s.close()
            time.sleep(0.1)
    finally:
        fppd.command("Test Stop")
