"""Another box's mDNS, for test_mdns_services.py; run inside its network
namespace (fake_devices.device_network):

    mdns_box.py SCENARIOS_DIR ADDRESS [INSTANCE SERVICE PORT TXT]

Joins the mDNS group on ADDRESS and prints "ptr <service> <instance> <ttl>"
for every PTR record it hears in an mDNS response, e.g. "ptr
_fppd._udp.local myhost._fppd._udp.local 120", a TTL of 0 being a goodbye.
Given INSTANCE SERVICE PORT TXT, it also announces INSTANCE.SERVICE.local at
ADDRESS:PORT (PTR, SRV, TXT and A records, as unsolicited answers) twice a
second. Prints "ready" once it listens.
"""

import select
import socket
import struct
import sys
import time

sys.path.insert(0, sys.argv[1])
from test_mdns import _name, _rr  # noqa: E402

ADDRESS = sys.argv[2]
GROUP = ("224.0.0.251", 5353)


def read_name(data, off):
    """The (possibly compressed) name at `off`, and the offset after it."""
    labels, end, hops = [], None, 0
    while True:
        n = data[off]
        if n & 0xC0 == 0xC0:
            if end is None:
                end = off + 2
            off = ((n & 0x3F) << 8) | data[off + 1]
            hops += 1
            if hops > 32:
                raise ValueError("pointer loop")
            continue
        if n == 0:
            return ".".join(labels), (end if end is not None else off + 1)
        labels.append(data[off + 1:off + 1 + n].decode(errors="replace"))
        off += 1 + n


def pointers(data):
    """(owner, target, ttl) of each PTR in an mDNS response."""
    _, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", data[:12])
    if not flags & 0x8000:
        return []
    off = 12
    for _ in range(qd):
        _, off = read_name(data, off)
        off += 4
    out = []
    for _ in range(an + ns + ar):
        owner, off = read_name(data, off)
        rtype, _, ttl, rdlen = struct.unpack("!HHIH", data[off:off + 10])
        off += 10
        if rtype == 12:
            out.append((owner, read_name(data, off)[0], ttl))
        off += rdlen
    return out


sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ADDRESS))
sock.bind(("", 5353))
sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                socket.inet_aton(GROUP[0]) + socket.inet_aton(ADDRESS))

answer = None
if len(sys.argv) > 6:
    instance, service, port, txt = sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6]
    full = f"{instance}.{service}.local"
    host = f"{instance}.local"
    rrs = [_rr(f"{service}.local", 12, 1, 120, _name(full)),
           _rr(full, 33, 0x8001, 120, struct.pack("!HHH", 0, 0, port) + _name(host)),
           _rr(full, 16, 0x8001, 120, bytes([len(txt)]) + txt.encode()),
           _rr(host, 1, 0x8001, 120, socket.inet_aton(ADDRESS))]
    answer = struct.pack("!HHHHHH", 0, 0x8400, 0, len(rrs), 0, 0) + b"".join(rrs)

print("ready", flush=True)
next_announce = 0
while True:
    now = time.monotonic()
    if answer and now >= next_announce:
        sock.sendto(answer, GROUP)
        next_announce = now + 0.5
    r, _, _ = select.select([sock], [], [], 0.1)
    if not r:
        continue
    data, src = sock.recvfrom(9000)
    if src[0] == ADDRESS:
        continue
    try:
        for owner, target, ttl in pointers(data):
            print(f"ptr {owner} {target.replace(' ', '_')} {ttl}", flush=True)
    except (ValueError, IndexError, struct.error):
        continue
