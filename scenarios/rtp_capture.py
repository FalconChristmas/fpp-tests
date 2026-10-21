"""Capture an RTP stream with kernel arrival times, for the AES67 sender.

Each packet is kept with the wall-clock time the kernel received it
(SO_TIMESTAMPNS), which is what the sender's RTP timestamps are counted
against when its media clock is CLOCK_REALTIME (PTP with software
timestamping, or no ptp4l at all). The lead of a packet -- how long before its
own playout time it arrived -- is then its RTP timestamp minus its arrival
time, both in samples, as AES67Manager's lead servo measures it.
"""

import socket
import struct
import threading

SO_TIMESTAMPNS = 35
RATE = 48000


class Packet:
    __slots__ = ("arrival_ns", "seq", "ts", "pt", "payload")

    def __init__(self, arrival_ns, data):
        self.arrival_ns = arrival_ns
        self.pt = data[1] & 0x7F
        self.seq, self.ts = struct.unpack(">HI", data[2:8])
        self.payload = data[12:]

    @property
    def payload_len(self):
        return len(self.payload)

    def peak(self):
        """The largest L24 sample magnitude in the packet, 0..1."""
        p = self.payload
        top = 0
        for i in range(0, len(p) - 2, 3):
            v = int.from_bytes(p[i:i + 3], "big", signed=True)
            top = max(top, abs(v))
        return top / (1 << 23)

    def lead_ms(self):
        arrival = (self.arrival_ns * RATE // 1_000_000_000) & 0xFFFFFFFF
        d = (self.ts - arrival) & 0xFFFFFFFF
        if d >= 1 << 31:
            d -= 1 << 32
        return d * 1000 / RATE


class RtpCapture:
    def __init__(self, port, host="127.0.0.1"):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 * 1024 * 1024)
        self.sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
        self.sock.bind((host, port))
        self.sock.settimeout(0.2)
        self.packets = []
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                data, anc, _, _ = self.sock.recvmsg(65536, 64)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(data) < 12:
                continue
            arrival = None
            for level, kind, raw in anc:
                if level == socket.SOL_SOCKET and kind == SO_TIMESTAMPNS:
                    sec, nsec = struct.unpack("qq", raw[:16])
                    arrival = sec * 1_000_000_000 + nsec
            if arrival is None:
                continue
            with self.lock:
                self.packets.append(Packet(arrival, data))

    def snapshot(self):
        with self.lock:
            return list(self.packets)

    def since(self, t_ns):
        return [p for p in self.snapshot() if p.arrival_ns >= t_ns]

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def discontinuities(packets, step):
    """(index, seq step, ts step) wherever consecutive packets do not advance
    the sequence number by 1 and the timestamp by `step` samples."""
    out = []
    for i, (a, b) in enumerate(zip(packets, packets[1:])):
        ds = (b.seq - a.seq) & 0xFFFF
        dt = (b.ts - a.ts) & 0xFFFFFFFF
        if ds != 1 or dt != step:
            out.append((i + 1, ds, dt))
    return out
