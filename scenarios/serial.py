"""Receive what fppd writes to a serial output.

A test opens a pty and points the output at its slave side ("pts/N"); a
PtyReader on the master side records everything fppd writes. Linux ptys
accept any baud rate, so an output's configured speed is kept as is.
"""

import os
import threading
import time


class PtyReader:
    def __init__(self):
        self.master, self.slave = os.openpty()
        os.set_blocking(self.master, False)
        self.device = os.ttyname(self.slave)[len("/dev/"):]  # e.g. "pts/3"
        self.data = bytearray()
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                chunk = os.read(self.master, 65536)
            except BlockingIOError:
                time.sleep(0.005)
                continue
            except OSError:
                break
            with self.lock:
                self.data += chunk

    def messages(self):
        """LOR messages so far: the byte runs between 0x00 delimiters."""
        with self.lock:
            return [bytes(m) for m in bytes(self.data).split(b"\x00") if m]

    def close(self):
        self.running = False
        self.thread.join()
        os.close(self.master)
        os.close(self.slave)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def lor_enhanced_state(messages):
    """Apply LOR Enhanced (0x8E) packets the way a Pixie does.

    Returns {unit id: {channel index: value}} for every channel some packet
    wrote. A jump skips channels without changing them; a repeat writes one
    RGB triplet to <count> pixels; a count of 0x1F means the count is in the
    next byte.
    """
    units = {}
    for m in messages:
        if len(m) < 2 or m[1] != 0x8E:
            continue  # heartbeat or anything else
        state = units.setdefault(m[0], {})
        i, at = 2, 0
        while i < len(m):
            op, n = m[i] >> 5, m[i] & 0x1F
            i += 1
            if n == 0x1F:
                n = m[i]
                i += 1
            if op == 0:
                for v in m[i:i + n]:
                    state[at] = v
                    at += 1
                i += n
            elif op == 1:
                at += n
            elif op == 2:
                rgb = m[i:i + 3]
                i += 3
                for _ in range(n):
                    for v in rgb:
                        state[at] = v
                        at += 1
            else:
                raise AssertionError(f"unknown LOR Enhanced op {op} in {m.hex(' ')}")
    return units
