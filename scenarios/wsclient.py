"""A small RFC 6455 WebSocket client for fppd's own sockets (the image's
Python has no websocket module): the handshake, masked client frames, and
reading the server's frames, with control frames handed back as they come."""

import base64
import hashlib
import os
import socket
import struct
import time

TEXT, BINARY, CLOSE, PING, PONG, CONT = 0x1, 0x2, 0x8, 0x9, 0xA, 0x0
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocket:
    def __init__(self, path, port=32322, host="127.0.0.1", timeout=10, rcvbuf=None,
                 handshake=True):
        self.s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if rcvbuf:
            self.s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, rcvbuf)
        self.s.settimeout(timeout)
        self.s.connect((host, port))
        self.buf = b""
        key = base64.b64encode(os.urandom(16))
        self.s.sendall(b"GET " + path.encode() + b" HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                       b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                       b"Sec-WebSocket-Key: " + key + b"\r\nSec-WebSocket-Version: 13\r\n\r\n")
        if not handshake:
            return
        while b"\r\n\r\n" not in self.buf:
            self._fill(timeout)
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        assert lines[0].split()[1] == "101", f"no upgrade: {head!r}"
        headers = {k.strip().lower(): v.strip() for k, v in
                   (line.split(":", 1) for line in lines[1:] if ":" in line)}
        want = base64.b64encode(hashlib.sha1(key + GUID).digest()).decode()
        assert headers.get("sec-websocket-accept") == want, f"bad accept key: {head!r}"

    def _fill(self, deadline_s):
        self.s.settimeout(max(deadline_s, 0.001))
        chunk = self.s.recv(65536)
        if not chunk:
            raise ConnectionError("the server closed the connection")
        self.buf += chunk

    def _take(self, n, deadline):
        while len(self.buf) < n:
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout("timed out reading a frame")
            self._fill(left)
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def frame(self, timeout=10):
        """The next frame: (fin, opcode, payload). Server frames are never masked."""
        deadline = time.monotonic() + timeout
        b0, b1 = self._take(2, deadline)
        assert not b1 & 0x80, "the server masked a frame (RFC 6455 5.1 forbids it)"
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._take(2, deadline))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._take(8, deadline))[0]
        return bool(b0 & 0x80), b0 & 0x0F, self._take(n, deadline)

    def message(self, timeout=10):
        """The next message: (opcode, payload), fragments joined. A ping from
        the server is answered and skipped; pongs and close come back as is."""
        deadline = time.monotonic() + timeout
        parts, op = [], None
        while True:
            fin, opcode, payload = self.frame(max(deadline - time.monotonic(), 0.001))
            if opcode == PING:
                self.send(payload, PONG)
                continue
            if opcode in (CLOSE, PONG):
                return opcode, payload
            op = opcode if op is None else op
            parts.append(payload)
            if fin:
                return op, b"".join(parts)

    def send(self, payload, opcode=TEXT, fin=True):
        if isinstance(payload, str):
            payload = payload.encode()
        mask, n = os.urandom(4), len(payload)
        b0 = (0x80 if fin else 0) | opcode
        if n < 126:
            head = bytes([b0, 0x80 | n])
        elif n < 65536:
            head = bytes([b0, 0x80 | 126]) + struct.pack(">H", n)
        else:
            head = bytes([b0, 0x80 | 127]) + struct.pack(">Q", n)
        self.s.sendall(head + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def send_close(self, code=1000):
        self.send(struct.pack(">H", code), CLOSE)

    def abort(self):
        """Drop the connection with a TCP reset: no close frame, no FIN."""
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.s.close()

    def close(self):
        self.s.close()
