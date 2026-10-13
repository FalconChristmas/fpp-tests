"""Build and parse the lighting protocols fppd speaks: E1.31 (sACN), Art-Net
ArtDMX and DDP. Written from the specs, not from FPP's code, so a scenario
checks fppd against the protocol rather than against itself."""

import socket
import struct
import threading
import time

E131_PORT = 5568
ARTNET_PORT = 6454
DDP_PORT = 4048

ACN_ID = b"ASC-E1.17\0\0\0"


def e131(universe, data, seq=0, priority=100, cid=b"fpp-tests-cid-01", source="fpp-tests",
         count=None, sync_universe=0):
    """An E1.31 data packet. `count` overrides the DMP property value count
    (start code included), to build a packet that claims less than it holds."""
    data = bytes(data)
    if count is None:
        count = len(data) + 1
    dmp = struct.pack(">HBBHHH", 0x7000 | (10 + len(data) + 1), 0x02, 0xA1, 0, 1, count) + b"\0" + data
    framing = (struct.pack(">HI", 0x7000 | (77 + len(dmp)), 0x00000004)
               + source.encode()[:63].ljust(64, b"\0")
               + struct.pack(">BHBBH", priority, sync_universe, seq & 0xFF, 0, universe) + dmp)
    root = (struct.pack(">HH", 0x0010, 0x0000) + ACN_ID
            + struct.pack(">HI", 0x7000 | (22 + len(framing)), 0x00000004)
            + cid.ljust(16, b"\0")[:16] + framing)
    assert len(root) == 126 + len(data)
    return root


def parse_e131(pkt):
    """(universe, sequence, priority, data) of an E1.31 data packet, or None."""
    if len(pkt) < 126 or pkt[4:16] != ACN_ID or pkt[21] != 4:
        return None
    count = struct.unpack(">H", pkt[123:125])[0]
    return {"universe": struct.unpack(">H", pkt[113:115])[0], "sequence": pkt[111],
            "priority": pkt[108], "start_code": pkt[125], "data": pkt[126:126 + count - 1],
            "source": pkt[44:108].rstrip(b"\0").decode(errors="replace")}


def artdmx(universe, data, seq=0, length=None):
    """An Art-Net ArtDMX packet. `length` overrides the header's data length."""
    data = bytes(data)
    if length is None:
        length = len(data)
    return (b"Art-Net\0" + struct.pack("<H", 0x5000) + struct.pack(">H", 14)
            + bytes([seq & 0xFF, 0]) + struct.pack("<H", universe) + struct.pack(">H", length) + data)


def parse_artdmx(pkt):
    if len(pkt) < 18 or pkt[:8] != b"Art-Net\0" or struct.unpack("<H", pkt[8:10])[0] != 0x5000:
        return None
    length = struct.unpack(">H", pkt[16:18])[0]
    return {"universe": struct.unpack("<H", pkt[14:16])[0], "sequence": pkt[12],
            "data": pkt[18:18 + length], "length": length}


def ddp(offset, data, push=True, seq=0, length=None):
    """A DDP data packet (data type 1). `length` overrides the header length."""
    data = bytes(data)
    if length is None:
        length = len(data)
    flags = 0x40 | (0x01 if push else 0)
    return bytes([flags, seq & 0x0F, 0x01, 0x01]) + struct.pack(">IH", offset, length) + data


class Sender:
    """Sends a set of packets to fppd over and over, every `interval`
    seconds, the way a show computer streams to a controller, until stopped.
    `packets(n)` returns the list of (bytes, port) to send on round n."""

    def __init__(self, packets, interval=0.05, host="127.0.0.1"):
        self.packets = packets
        self.interval = interval
        self.host = host
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rounds = 0
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            for pkt, port in self.packets(self.rounds):
                try:
                    self.sock.sendto(pkt, (self.host, port))
                except OSError:
                    pass
            self.rounds += 1
            time.sleep(self.interval)

    def stop(self):
        self.running = False
        self.thread.join()

    def close(self):
        self.stop()
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def send(packets, port, host="127.0.0.1"):
    """Send each packet once."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        for p in packets:
            s.sendto(p, (host, port))
