"""Receive what fppd sends to its outputs.

A test points an output at 127.0.0.1 and a port, and a Listener bound there
records every packet with its arrival time, so a scenario can check what came
out, how often, and when it stopped.
"""

import socket
import threading
import time


class Listener:
    def __init__(self, port, host="127.0.0.1"):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        self.sock.bind((host, port))
        self.sock.settimeout(0.2)
        self.packets = []  # (monotonic time, bytes)
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                data, _ = self.sock.recvfrom(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            with self.lock:
                self.packets.append((time.monotonic(), data))

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def count_since(self, start, end=None):
        with self.lock:
            return sum(1 for t, _ in self.packets if t >= start and (end is None or t < end))

    def rate(self, seconds):
        """Packets per second over the next `seconds`."""
        start = time.monotonic()
        time.sleep(seconds)
        return self.count_since(start) / seconds

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
