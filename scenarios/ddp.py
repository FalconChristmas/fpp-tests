"""Receive DDP the way a pixel controller does, and rebuild whole frames.

DDP data packets carry an offset and a length; the packet with the PUSH flag
ends a frame. Each completed frame is kept with its arrival time.
"""

import socket
import struct
import threading
import time

DDP_PORT = 4048
FLAG_PUSH = 0x01
FLAG_TIMECODE = 0x10


class DdpReceiver:
    def __init__(self, channels, port=DDP_PORT, host="0.0.0.0"):
        self.channels = channels
        self.buffer = bytearray(channels)
        self.frames = []  # (monotonic time, bytes)
        self.lock = threading.Lock()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
        self.sock.bind((host, port))
        self.sock.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                pkt = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(pkt) < 10:
                continue
            flags = pkt[0]
            header = 14 if flags & FLAG_TIMECODE else 10
            offset, length = struct.unpack(">IH", pkt[4:10])
            data = pkt[header:header + length]
            end = min(offset + len(data), self.channels)
            if offset < end:
                self.buffer[offset:end] = data[:end - offset]
            if flags & FLAG_PUSH:
                with self.lock:
                    self.frames.append((time.monotonic(), bytes(self.buffer)))

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # --- reading -----------------------------------------------------------

    def snapshot(self, since=None):
        with self.lock:
            return [f for f in self.frames if since is None or f[0] >= since]

    def count(self, since=None):
        return len(self.snapshot(since))

    def last(self):
        with self.lock:
            return self.frames[-1][1] if self.frames else None

    def wait_frames(self, n, timeout=10, since=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.count(since) >= n:
                return True
            time.sleep(0.05)
        return False
