"""WebSocket endpoints registered by a native plugin
(registerPluginWebSocket), reached through fppd's /fppdws/plugin route."""

import base64
import os
import socket
import struct

import native_plugin


def handshake(query, port=32322):
    """Open /fppdws/plugin?<query>; return (socket, status line)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /fppdws/plugin?{query} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
    return s, buf.split(b"\r\n")[0].decode(), buf.split(b"\r\n\r\n", 1)[1]


def send_text(s, text):
    data = text.encode()
    mask = os.urandom(4)
    s.sendall(bytes([0x81, 0x80 | len(data)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def read_text(s, leftover=b""):
    buf = leftover
    while len(buf) < 2:
        buf += s.recv(4096)
    n = buf[1] & 0x7F
    assert n < 126
    while len(buf) < 2 + n:
        buf += s.recv(4096)
    return buf[2:2 + n].decode()


def test_a_plugin_websocket_answers_and_unknown_names_are_refused(fppd):
    """A plugin's registered endpoint completes the handshake and echoes
    through its handler; a name nobody registered is refused with a 404.

    Feature: 597ceaca7 (FPP 10.4)."""
    native_plugin.install(fppd, name="fpp-wstest", source="wsplugin.cpp")
    fppd.start()
    s, status, rest = handshake("name=wstest/echo")
    try:
        assert " 101 " in status, status
        send_text(s, "hello")
        assert read_text(s, rest) == "echo:hello"
    finally:
        s.close()
    s2, status2, _ = handshake("name=wstest/nobody")
    s2.close()
    assert " 404 " in status2, status2
