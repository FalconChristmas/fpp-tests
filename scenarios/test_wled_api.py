"""fppd's WLED-compatible API (WLEDAPIResponder): the JSON state/info
endpoints and the WebSocket the WLED apps use, on 127.0.0.1:32327. Apache
proxies /ws to it from the LAN, so what arrives there is a network peer's
JSON."""

import base64
import json
import os
import socket
import struct
import time

import pytest

from ddp import DdpReceiver
from show import ddp_output
from test_overlays import CHANNELS, matrix, setup

PORT = 32327


def http(method, path, body=None, timeout=5):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=timeout)
    data = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
    s.sendall(f"{method} {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {len(data)}\r\n\r\n".encode()
              + data)
    out = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        out += chunk
    s.close()
    head, _, payload = out.partition(b"\r\n\r\n")
    return int(head.split()[1]), payload


class WS:
    """A minimal WebSocket client, as the WLED apps use it."""

    def __init__(self, timeout=5):
        self.s = socket.create_connection(("127.0.0.1", PORT), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1)
        assert b" 101 " in head.split(b"\r\n")[0], head
        self.first = self.recv()  # the state snapshot sent on connect

    def send(self, payload, opcode=0x1):
        if isinstance(payload, (dict, list)):
            payload = json.dumps(payload)
        if isinstance(payload, str):
            payload = payload.encode()
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = bytes([0x80 | opcode, 0x80 | n])
        elif n < 65536:
            hdr = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def _exact(self, n):
        out = b""
        while len(out) < n:
            chunk = self.s.recv(n - len(out))
            if not chunk:
                raise ConnectionError("closed")
            out += chunk
        return out

    def recv(self):
        h = self._exact(2)
        n = h[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._exact(8))[0]
        return h[0] & 0x0F, self._exact(n)

    def close(self):
        self.s.close()


def effects():
    code, body = http("GET", "/json/eff")
    assert code == 200
    return json.loads(body)


def start(fppd):
    setup(fppd, [matrix()])
    fppd.start()
    fppd.wait_for(lambda: _answers(), timeout=10, what="the WLED API to listen")


def _answers():
    try:
        return http("GET", "/json/info")[0] == 200
    except OSError:
        return False


BAD_STATES = [
    {"seg": [{"id": "x"}]},
    {"on": "yes"},
    {"on": [1]},
    {"seg": [5]},
    {"seg": [{"id": 0, "on": "maybe"}]},
    {"seg": [{"id": 0, "fx": "a"}]},
    {"seg": [{"id": 0, "fx": 3, "sx": "fast"}]},
    {"seg": [{"id": 0, "fx": 3, "col": [["a", 0, 0]]}]},
    {"seg": [{"id": 0, "fx": 3, "o1": "x", "c1": "y"}]},
    {"seg": [{"id": 1e30}]},
]


@pytest.mark.parametrize("via", ["http", "websocket"])
def test_wrong_typed_state_is_survived(fppd, via):
    """State updates whose fields have the wrong JSON type (a string where
    a number or bool belongs, an entry that isn't an object) are ignored,
    over HTTP and over the WebSocket, and each still gets its answer.

    Regression: d6494e109. jsoncpp threw on the first wrong-typed read,
    on the client thread, and std::terminate took fppd down."""
    start(fppd)
    for body in BAD_STATES:
        if via == "http":
            code, reply = http("POST", "/json/state", body)
            assert code == 200 and "seg" in json.loads(reply), body
        else:
            ws = WS()
            ws.send(body)
            opcode, reply = ws.recv()
            assert opcode == 1 and "state" in json.loads(reply), body
            ws.close()
        fppd.check_alive()
    assert "dropped a request" not in fppd.log()


def test_every_effect_index_can_be_chosen(fppd):
    """A WLED app picks an effect by its index in /json/eff. Choosing any of
    them, the FPP-native effects (Bars, Text, ...) as well as the WLED
    ones, starts it (or, for one that needs what WLED doesn't send, refuses
    it) and fppd carries on.

    Regression: d6494e109. The FPP-native effects aren't WLEDEffects, and
    a static_cast to one called getArgRoles() through a vtable slot they
    don't have: SIGSEGV. Color Fade, given no fade times, then threw on
    std::stol on an empty string."""
    start(fppd)
    names = effects()
    native = [i for i, n in enumerate(names) if not n.startswith("WLED")]
    assert native, names
    for i in native + [i for i, n in enumerate(names) if n.startswith("WLED")][:3]:
        code, _ = http("POST", "/json/state", {"seg": [{"id": 0, "fx": i, "sx": 200, "ix": 50,
                                                        "col": [[255, 0, 0], [0, 255, 0], [0, 0, 255]]}]})
        assert code == 200, names[i]
        time.sleep(0.2)
        fppd.check_alive()
        if names[i] == "Bars":  # Color Fade with no fade times ends at once
            seg = json.loads(http("GET", "/json/state")[1])["seg"][0]
            assert seg["fx"] == i, f"{names[i]} isn't running: {seg}"
    assert "dropped a request" not in fppd.log()


def vm_size(pid):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmSize:"):
                return int(line.split()[1]) * 1024
    return 0


def test_requests_do_not_pile_up_threads(fppd):
    """A WLED app polls /json every second or two, for as long as it's
    open. Each request runs on a thread of its own; finished ones must not
    accumulate, or fppd's address space grows by a thread stack per poll
    until a thread can't be created.

    Regression: d6494e109. Each request's thread was joined only at
    shutdown: 300 requests grew fppd's address space by 2.4 GB."""
    start(fppd)
    for _ in range(20):
        http("GET", "/json")
    before = vm_size(fppd.proc.pid)
    n = 300
    for _ in range(n):
        http("GET", "/json/info")
    grown = vm_size(fppd.proc.pid) - before
    assert grown < 64 * 1024 * 1024, f"address space grew {grown // 2**20} MB over {n} requests"


def test_a_client_that_stops_reading_does_not_wedge_the_api(fppd):
    """A WebSocket client that stops reading (an app backgrounded on a
    phone) while another keeps changing state: the API keeps answering, and
    fppd still shuts down.

    Regression: d6494e109. State changes are pushed to every WebSocket
    client under one lock, with a blocking send; once the stalled client's
    buffers filled, the send never returned, and everything else that takes
    that lock -- accepting a connection, shutdown -- waited on it."""
    import threading
    start(fppd)
    stalled = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    stalled.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    stalled.connect(("127.0.0.1", PORT))
    stalled.sendall(b"GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
    # ...and never read from it again.
    stop = threading.Event()

    def drive():
        try:
            ws = WS(timeout=60)
            while not stop.is_set():
                ws.send({"on": True})
                ws.recv()
        except Exception:
            pass

    t = threading.Thread(target=drive, daemon=True)
    t.start()
    time.sleep(20)  # thousands of state changes, each pushed to the stalled client
    try:
        began = time.monotonic()
        code, _ = http("GET", "/json/info", timeout=10)
        assert code == 200 and time.monotonic() - began < 5, "the API stopped answering"
    finally:
        stop.set()
    t.join(5)
    rc = fppd.stop(timeout=20)
    fppd.exit_expected = True
    stalled.close()
    assert rc == 0, f"fppd exited {rc}"


def _first_line(s, timeout):
    s.settimeout(timeout)
    head = b""
    try:
        while b"\r\n" not in head:
            chunk = s.recv(1024)
            if not chunk:
                break
            head += chunk
    except socket.timeout:
        pass
    return head.split(b"\r\n")[0]


def test_an_oversized_body_is_refused_not_buffered(fppd):
    """A POST to the WLED API claiming a huge body is answered 413 at once,
    and its body is not read; a client asking for "100 Continue" gets it.

    Apache proxies /ws here without the UI password, so this is any LAN peer.

    Regression: 2aa30ea41. The plain-HTTP path read the body up to whatever
    Content-Length said, with no cap and no timeout: a large enough upload
    grew fppd until the OOM killer took it. "Expect: 100-continue" (curl's
    default) was never answered, so such a client and the proxy waited on
    each other until the proxy timed out."""
    start(fppd)
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    # Only the header: a refusal closes with the body unread, and unread data
    # would turn that close into a reset that can eat the answer.
    s.sendall(b"POST /json/state HTTP/1.1\r\nHost: x\r\nContent-Length: 2000000000\r\n\r\n")
    line = _first_line(s, 5)
    s.close()
    assert b" 413 " in line, f"answer to a 2 GB claimed body: {line!r}"

    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    body = json.dumps({"on": True}).encode()
    s.sendall(f"POST /json/state HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\n"
              f"Content-Length: {len(body)}\r\n\r\n".encode())
    line = _first_line(s, 3)
    assert b" 100 " in line, f"answer to Expect: 100-continue: {line!r}"
    s.sendall(body)
    s.close()
    assert http("GET", "/json/info")[0] == 200


def test_audio_input_setting_cannot_add_pipeline_elements(fppd):
    """WLEDAudioInput names a capture device; it is set on the source as a
    property, so a value that reads like more pipeline is just a device name
    that doesn't open.

    Regression: 89cdccb48. The value was pasted into a gst_parse_launch()
    description, so "null ! fakesink filesrc location=A ! filesink
    location=B appsrc" opened ALSA's null device and then copied A to B as
    root. The setting is writable with no authentication through the legacy
    MultiSync SetSetting packet."""
    src = os.path.join(fppd.media, "upload", "secret.txt")
    dst = os.path.join(fppd.media, "upload", "copied.txt")
    fppd.write("upload/secret.txt", "fpp-tests-secret\n")
    fppd.settings(MediaBackend="alsa", WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1",
                  WLEDAudioInput=f"null ! fakesink filesrc location={src} ! filesink location={dst} appsrc")
    fppd.start()
    time.sleep(5)
    assert not os.path.exists(dst), "WLEDAudioInput added elements to the capture pipeline"
    assert fppd.get("/fppd/status").get("status_name") is not None
