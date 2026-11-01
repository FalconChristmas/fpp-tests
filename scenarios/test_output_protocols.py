"""Network output protocols on the wire: E1.31, Art-Net and DDP packets
checked against the protocol specs (packets.py parses them independently of
FPP), and their data checked against the sequence that is playing.

The bridge inputs are off (DisableFakeNetworkBridges, no ci-universes), so
the E1.31 and Art-Net ports on 127.0.0.1 are free for a Listener here.
"""

import os
import struct
import time

import pytest

from fseq import unique_frames, write_fseq
from packets import ACN_ID, ARTNET_PORT, DDP_PORT, E131_PORT, Sender, parse_artdmx, parse_e131
from show import playlist, sequence_entry
from udp import Listener


def play(fppd, frames, outputs):
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": len(frames[0]),
        "universes": outputs}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")


def output(type_, id_, start, count, universes=1, **extra):
    u = {"active": 1, "description": "test", "id": id_, "universeCount": universes,
         "startChannel": start, "channelCount": count, "type": type_,
         "address": "127.0.0.1", "priority": 0, "monitor": 0, "deDuplicate": 0}
    u.update(extra)
    return u


def packets(listener):
    with listener.lock:
        return [p for _, p in listener.packets]


def slices(frames, start, size):
    """Every source frame's channels start..start+size-1 (0-based start)."""
    return {f[start:start + size] for f in frames}


def check_sequence_numbers(seqs, what, skip_zero=False, low=0, high=255):
    """A stream's sequence numbers count up by exactly one per packet from
    the first, wrapping from `high` to `low` (to 1 for Art-Net, where 0
    means "no sequence numbers").

    Regression: a frame prepared twice before it was sent (as one is when
    playback starts) used up a sequence number for the discarded
    preparation, so the stream skipped one or two numbers as it started --
    which a receiver counts as lost packets. Fixed by 256b0cf8e.
    """
    for i, (a, b) in enumerate(zip(seqs, seqs[1:])):
        want = low if a == high else a + 1
        if skip_zero and want == 0:
            want = 1
        assert b == want, \
            f"{what}: sequence number went {a} -> {b} (packet {i + 1}: {seqs[max(0, i - 5):i + 6]})"


def e131_lengths_agree(pkt):
    """The three E1.31 flags+length fields each cover the rest of the packet
    from where they sit, with the 0x7 flags nibble."""
    for at in (16, 38, 115):
        fl = struct.unpack(">H", pkt[at:at + 2])[0]
        if fl >> 12 != 0x7 or (fl & 0x0FFF) != len(pkt) - at:
            return False
    return True


def test_e131_unicast_packets(fppd):
    """Three E1.31 universes of 170 channels (one entry, universeCount 3):
    every packet is well formed (ANSI E1.31 lengths, vectors, start code 0,
    property count), carries its configured universe and priority, counts
    its sequence number up by one per universe, and carries the right
    slice of a frame of the sequence."""
    size = 170
    frames = unique_frames(80, 3 * size)
    with Listener(E131_PORT) as rx:
        play(fppd, frames, [output(1, 7, 1, size, universes=3, priority=77)])
        time.sleep(3)
        pkts = packets(rx)
    assert len(pkts) > 30, f"only {len(pkts)} E1.31 packets arrived"
    by_universe = {}
    for p in pkts:
        e = parse_e131(p)
        assert e is not None, f"not an E1.31 data packet: {p[:40].hex()}"
        assert e131_lengths_agree(p), "E1.31 flags/length fields don't match the packet"
        assert e["start_code"] == 0 and e["priority"] == 77
        assert len(e["data"]) == size == len(p) - 126
        by_universe.setdefault(e["universe"], []).append(e)
    assert sorted(by_universe) == [7, 8, 9]
    for u, es in by_universe.items():
        check_sequence_numbers([e["sequence"] for e in es], f"universe {u}")
        valid = slices(frames, (u - 7) * size, size)
        # blank frames before and after the show are fine
        bad = [e for e in es if any(e["data"]) and e["data"] not in valid]
        assert not bad, f"universe {u}: {len(bad)} packets whose data is not that universe's slice of any frame"


def test_artnet_unicast_packets(fppd):
    """Two Art-Net universes from port-address 0x0123 (type 9: unicast from
    an ephemeral port, so the Listener can hold 6454): ArtDMX op code and
    protocol version 14, little-endian port address, big-endian length,
    a sequence number that counts 1..255 and never sends 0, and the
    right slice of a frame."""
    size = 100
    frames = unique_frames(80, 2 * size)
    with Listener(ARTNET_PORT) as rx:
        play(fppd, frames, [output(9, 0x0123, 1, size, universes=2)])
        time.sleep(3)
        pkts = packets(rx)
    dmx = [parse_artdmx(p) for p in pkts]
    dmx = [d for d in dmx if d]  # ArtSync and other op codes are not data
    assert len(dmx) > 30, f"only {len(dmx)} ArtDMX packets arrived"
    by_universe = {}
    for p, d in zip([p for p in pkts if parse_artdmx(p)], dmx):
        assert struct.unpack(">H", p[10:12])[0] == 14, "ArtDMX protocol version is not 14"
        assert d["length"] == size and len(d["data"]) == size
        assert d["sequence"] != 0, "sequence number 0 means 'disabled' in Art-Net"
        by_universe.setdefault(d["universe"], []).append(d)
    assert sorted(by_universe) == [0x123, 0x124]
    for u, ds in by_universe.items():
        check_sequence_numbers([d["sequence"] for d in ds], f"universe {u:#x}", skip_zero=True)
        valid = slices(frames, (u - 0x123) * size, size)
        assert all(d["data"] in valid for d in ds if any(d["data"])), \
            f"universe {u:#x} carried data from no frame"


@pytest.mark.parametrize("ddp_type, first_offset", [(4, 300), (5, 0)])
def test_ddp_offsets_and_push(fppd, ddp_type, first_offset):
    """A DDP output of 1500 channels from channel 301 splits into 1440- and
    60-channel packets, with only the last pushing. Type 4 numbers channels
    from the start of channel space (offset 300); type 5 from the output's
    own first channel (offset 0)."""
    frames = unique_frames(80, 1800)
    with Listener(DDP_PORT) as rx:
        play(fppd, frames, [output(ddp_type, 64001, 301, 1500)])
        time.sleep(2)
        pkts = packets(rx)
    assert len(pkts) > 20
    # DDP numbers every packet 1..15 (0 means unnumbered)
    check_sequence_numbers([p[1] & 0x0F for p in pkts], "DDP", low=1, high=15)
    for i in range(0, len(pkts) - 1):
        p = pkts[i]
        flags, offset, length = p[0], struct.unpack(">I", p[4:8])[0], struct.unpack(">H", p[8:10])[0]
        assert flags & 0xC0 == 0x40, "DDP version is not 1"
        assert length == len(p) - 10
        assert (offset, length, bool(flags & 1)) in {
            (first_offset, 1440, False), (first_offset + 1440, 60, True)}, \
            f"unexpected DDP packet: offset {offset}, length {length}, flags {flags:#x}"
    # Frames reassemble into the output's slice of a source frame.
    valid = slices(frames, 300, 1500)
    frame = bytearray(1500)
    complete = 0
    for p in pkts:
        offset, length = struct.unpack(">I", p[4:8])[0] - first_offset, struct.unpack(">H", p[8:10])[0]
        frame[offset:offset + length] = p[10:10 + length]
        if p[0] & 1 and any(frame):  # blank frames before and after the show are fine
            assert bytes(frame) in valid, "a pushed DDP frame is not the output's slice of any frame"
            complete += 1
    assert complete > 10


def test_deduplicate_resends_only_changes_and_keepalives(fppd):
    """With deDuplicate on, a universe whose data doesn't change is resent
    only every 11th frame as a keepalive; one whose data changes every
    frame is sent every frame."""
    # universe 1: channels 1-200, never changes; universe 2: 201-400, changes
    frames = [bytes([0x40]) * 200 + f for f in unique_frames(80, 200)]
    with Listener(E131_PORT) as rx:
        play(fppd, frames, [
            output(1, 1, 1, 200, deDuplicate=1), output(1, 2, 201, 200, deDuplicate=1)])
        time.sleep(1)
        start = time.monotonic()
        time.sleep(2)
        with rx.lock:
            recent = [parse_e131(p) for t, p in rx.packets if t >= start]
    still = sum(1 for e in recent if e["universe"] == 1)
    moving = sum(1 for e in recent if e["universe"] == 2)
    assert moving >= 30, f"the changing universe was sent only {moving} times in 2 s"
    assert 1 <= still <= 6, f"the static universe was sent {still} times in 2 s (want a keepalive every 11 frames)"


def test_artnet_deduplicate_keeps_working(fppd):
    """With deDuplicate on, an ArtNet universe that doesn't change is resent
    only as a keepalive (every 11th frame) for the whole run.

    Regression: c65e2cf67. ArtNet never reset its skipped-frame counter, so
    after the first ten skipped frames de-duplication was off for good and
    the static universe went out every frame.
    """
    frames = [bytes([0x30] * 100)] * 200  # static, 10 s
    with Listener(ARTNET_PORT) as rx:
        play(fppd, frames, [output(9, 1, 1, 100, deDuplicate=1)])
        time.sleep(2)  # well past the first ten skipped frames
        start = time.monotonic()
        time.sleep(3)
        with rx.lock:
            sent = sum(1 for t, p in rx.packets if t >= start and parse_artdmx(p))
    assert 2 <= sent <= 10, f"a static ArtNet universe was sent {sent} times in 3 s (keepalive is every 11th frame)"


@pytest.mark.parametrize("udp_type, port, name", [(5, DDP_PORT, "DDP"), (1, E131_PORT, "E1.31")])
def test_deduplicate_keeps_working_for_ddp_and_e131(fppd, udp_type, port, name):
    """With deDuplicate on, a DDP or E1.31 universe that doesn't change is
    resent only as a keepalive for the whole run: about one packet in eleven
    frames, three seconds after the first ten skipped frames, not one every
    frame.

    Regression: 36fc2f718. The skipped-frame counter was kept for ArtNet
    alone; the others never reset it, so after the first ten skipped frames
    de-duplication was off for good."""
    frames = [bytes([0x30] * 100)] * 200  # static, 10 s
    with Listener(port) as rx:
        play(fppd, frames, [output(udp_type, 1, 1, 100, deDuplicate=1)])
        time.sleep(2)  # well past the first ten skipped frames
        start = time.monotonic()
        time.sleep(3)
        with rx.lock:
            sent = sum(1 for t, p in rx.packets if t >= start)
    assert 2 <= sent <= 14, f"a static {name} universe was sent {sent} times in 3 s (keepalive is every 11th frame)"


KINET_PORT = 6038


@pytest.mark.parametrize("version", [1, 2])
def test_kinet_packets(fppd, version):
    """KiNet v1 (DMXOUT) and v2 (PORTOUT): every packet carries the KiNet
    magic, version 1 and its message type, the v1 21-byte or v2 24-byte
    header (v2: universe 0xFFFFFFFF and a sequence number counting up per
    port), consecutive ports for one entry's universes, and that universe's
    slice of a frame. (The base port numbering -- FPP sends the id as is,
    xLights' own output sends it less one -- is not checked here.)

    Regression: 1ab6a39a2. v2 advanced the sequence number when it prepared a
    packet, so a frame prepared twice at playback start skipped one (1, 3,
    4, 6, ...), as E1.31, Art-Net and DDP did before 256b0cf8e.

    Also 4fff29473: the v2 sequence number is 32 bits at bytes 8-11 of the
    header (it was kept in one byte further on)."""
    size, base = 170, 4
    frames = unique_frames(80, 3 * size)
    with Listener(KINET_PORT) as rx:
        play(fppd, frames, [output(5 + version, base, 1, size, universes=3)])
        time.sleep(3)
        pkts = packets(rx)
    assert len(pkts) > 30, f"only {len(pkts)} KiNet packets arrived"
    hlen = 21 if version == 1 else 24
    by_port = {}
    for p in pkts:
        assert p[0:4] == bytes.fromhex("0401dc4a"), p[:8].hex()
        assert struct.unpack("<H", p[4:6])[0] == 1, p[:8].hex()
        assert struct.unpack("<H", p[6:8])[0] == (0x0101 if version == 1 else 0x0108), p[:8].hex()
        assert len(p) == hlen + size, len(p)
        if version == 1:
            assert p[16:20] == b"\xff\xff\xff\xff", p[:hlen].hex()
            port = p[12]
        else:
            assert p[12:16] == b"\xff\xff\xff\xff", p[:hlen].hex()
            port = p[16]
        by_port.setdefault(port, []).append(p)
    ports = sorted(by_port)
    assert len(ports) == 3 and ports == [ports[0], ports[0] + 1, ports[0] + 2], ports
    for k, port in enumerate(ports):
        ps = by_port[port]
        if version == 2:
            seqs = [struct.unpack("<I", p[8:12])[0] for p in ps]
            assert all(b == a + 1 for a, b in zip(seqs, seqs[1:])), f"port {port}: {seqs[:10]}"
        valid = slices(frames, k * size, size)
        bad = [p for p in ps if any(p[hlen:]) and p[hlen:] not in valid]
        assert not bad, f"port {port}: {len(bad)} packets whose data is not its slice of a frame"


def test_generic_udp_tokens(fppd):
    """A Generic UDP output lays its packet out from the Data tokens: hex
    bytes (0x.. and #..), the channel and pixel counts in one byte and in
    two bytes of each order ({S2}/{P2} low byte first, {s2}/{p2} high byte
    first, as they always have been), and the frame's channel data.

    Guards 85883b709, which swapped the names of the two byte-order helpers
    (addLittleEndian() put the high byte first) and which token calls which:
    the bytes on the wire must not change with it."""
    size = 300
    frames = unique_frames(60, size)
    port = 9123
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": size,
        "description": "tokens", "address": "127.0.0.1", "port": port,
        "tokens": "0xAA {S1} {S2} {s2} {P1} {P2} {p2} {data} #BB"}]})
    with Listener(port) as rx:
        play(fppd, frames, [output(5, 1, 1, size)])  # GenericUDP sends with the universes output
        time.sleep(3)
        pkts = packets(rx)
    assert pkts, "no Generic UDP packets"
    head = bytes([0xAA, size & 0xFF, 0x2C, 0x01, 0x01, 0x2C, 100, 100, 0, 0, 100])
    valid = set(frames)
    for p in pkts:
        assert p[:len(head)] == head, p[:len(head)].hex()
        assert p[-1] == 0xBB and len(p) == len(head) + size + 1, (len(p), p[-4:].hex())
        data = p[len(head):-1]
        assert not any(data) or data in valid, data[:8].hex()


ADDR_IFACE = "fpptd0"


def ip(*args):
    import subprocess
    return subprocess.run(["ip", *args], capture_output=True, text=True)


def address_less_interface():
    """fpptd0: a dummy interface, up, multicast on, with no address yet."""
    ip("link", "del", ADDR_IFACE)
    r = ip("link", "add", ADDR_IFACE, "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    ip("link", "set", ADDR_IFACE, "multicast", "on", "up")


def sources_since(cap, since):
    return {src for t, src, dst, _ in cap.snapshot() if t >= since}


def test_multicast_follows_the_output_interfaces_address(fppd):
    """E1.31 multicast on an interface that has no address when fppd starts
    leaves that interface once the address arrives, from that address, and
    follows the interface to a new address when it changes.

    Regression: 6b40e5c79. Init() marked the address-less interface up and
    ignored its NEW_ADDR, so the multicast socket stayed bound to 127.0.0.1
    with IP_MULTICAST_IF loopback and nothing reached the interface until
    fppd restarted; after a change, InitNetwork() reset the address to
    loopback before returning early.
    """
    from capture import UdpCapture

    address_less_interface()
    try:
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
            "interface": ADDR_IFACE,
            "universes": [output(0, 1, 1, 510)]}]})
        fppd.settings(DisableFakeNetworkBridges="1")
        with UdpCapture(E131_PORT, dst_ip="239.255.0.1", iface=ADDR_IFACE) as cap:
            fppd.start()
            fppd.request("PUT", "/overlays/range/1-510", {"Value": 42})
            time.sleep(2)
            ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
            fppd.wait_for(lambda: "10.66.0.1" in sources_since(cap, time.monotonic() - 1),
                          timeout=10, what="multicast from 10.66.0.1 on the interface")
            ip("addr", "del", "10.66.0.1/24", "dev", ADDR_IFACE)
            time.sleep(1)
            ip("addr", "add", "10.66.0.2/24", "dev", ADDR_IFACE)
            fppd.wait_for(lambda: sources_since(cap, time.monotonic() - 1) == {"10.66.0.2"},
                          timeout=10, what="multicast from the new address 10.66.0.2 only")
    finally:
        ip("link", "del", ADDR_IFACE)


def test_e131_sync_leaves_by_the_output_interface(fppd):
    """E1.31 sync for unicast universes on a show interface (fpptd0) goes
    out of that interface to 239.255.<sync universe>, not by the default
    route (the container's eth0).

    Regression: 56c9a4652. The sync socket was not a multicast one, so it
    had no IP_MULTICAST_IF and followed the default route: controllers on
    the show network never saw sync.
    """
    from capture import UdpCapture

    address_less_interface()
    try:
        ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
        entry = output(1, 1, 1, 510, syncUniverse=7)
        entry["address"] = "10.66.0.2"
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
            "interface": ADDR_IFACE, "universes": [entry]}]})
        fppd.settings(DisableFakeNetworkBridges="1")
        with UdpCapture(E131_PORT, dst_ip="239.255.0.7", iface=ADDR_IFACE) as sync, \
                UdpCapture(E131_PORT, dst_ip="10.66.0.2", iface=ADDR_IFACE) as data:
            fppd.start()
            fppd.command("Test Start", "100", "RGB Cycle", "1-510", "R-G-B")
            fppd.wait_for(lambda: data.snapshot(), timeout=10, what="E1.31 data on the interface")
            fppd.wait_for(lambda: sync.snapshot(), timeout=10,
                          what="E1.31 sync to 239.255.0.7 on the interface")
    finally:
        ip("link", "del", ADDR_IFACE)


def socket_fds(pid):
    """fppd's UDP sockets. TCP is left out: MultiSync discovery opens HTTP
    connections to any other player it finds on the network, another test
    run's container included, which says nothing about Art-Net's sockets."""
    udp = set()
    for table in ("udp", "udp6"):
        try:
            with open(f"/proc/{pid}/net/{table}") as f:
                next(f)
                udp.update(line.split()[9] for line in f)
        except OSError:
            pass
    n = 0
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            link = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        n += link.startswith("socket:") and link[8:-1] in udp
    return n


def test_a_full_artnet_socket_is_waited_on_not_replaced(fppd):
    """Unicast Art-Net to a controller behind a slow link (a tbf qdisc
    draining fpptd0 at 100 kbit/s, far below the 20 universes' rate) fills
    the shared Art-Net socket's send buffer; fppd waits for room on that
    socket rather than opening more.

    Regression: c2a373924. EAGAIN moved the Art-Net keys on to new
    ephemeral sockets, without SO_BROADCAST or port 6454, that were never
    closed: up to four more per destination key, and broadcast Art-Net and
    sync then failed on them every frame.
    """
    address_less_interface()
    try:
        ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
        import subprocess
        r = subprocess.run(["tc", "qdisc", "add", "dev", ADDR_IFACE, "root", "tbf", "rate", "100kbit",
                            "burst", "2k", "limit", "4mb"], capture_output=True, text=True)
        if r.returncode:
            pytest.skip(f"tbf: {r.stderr.strip()}")
        universes = []
        for n in range(20):
            u = output(3, n + 1, 1 + 510 * n, 510)
            u["address"] = "10.66.0.2"
            universes.append(u)
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 20 * 510,
            "interface": ADDR_IFACE, "universes": universes}]})
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-10200", "R-G-B")
        time.sleep(1)
        before = socket_fds(fppd.proc.pid)
        time.sleep(8)
        after = socket_fds(fppd.proc.pid)
        assert "Resource temporarily unavailable" in fppd.log() or "exceeded time budget" in fppd.log(), \
            "the Art-Net socket's buffer never filled"
        assert after <= before, f"fppd went from {before} to {after} sockets while the link was full"
    finally:
        ip("link", "del", ADDR_IFACE)


def test_mqtt_output_value_and_intensity_tokens(fppd):
    """An MQTT output's %V% and %I% payload tokens carry a half-lit RGB
    pixel's value and intensity: "50 50" for 128, 128, 128.

    Regression: 85f33b352. The channels were divided by 255 as integers
    before the HSV/intensity conversion, so every token was 0 below full
    brightness and the payload was "0 0".
    """
    import shutil
    import subprocess
    if not shutil.which("mosquitto") or not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto and mosquitto_sub are not installed")
    port = "18832"
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "MQTTOutput", "enabled": 1, "startChannel": 1, "channelCount": 3,
        "topic": "fpptest/out", "payload": "%V% %I%", "channelType": "RGB"}]})
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=port, HostName="mqttout",
                  DisableFakeNetworkBridges="1")
    broker = subprocess.Popen(["mosquitto", "-p", port],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sub = None
    try:
        time.sleep(0.5)
        sub = subprocess.Popen(["mosquitto_sub", "-h", "127.0.0.1", "-p", port, "-v",
                                "-t", "#", "-W", "20"], stdout=subprocess.PIPE, text=True)
        fppd.start()
        time.sleep(2)  # let fppd connect before the channels change
        fppd.request("PUT", "/overlays/range/1-3", {"Value": 128})
        out, _ = sub.communicate(timeout=30)
    finally:
        if sub and sub.poll() is None:
            sub.kill()
        broker.terminate()
        broker.wait(timeout=5)
    published = [line for line in out.splitlines() if "fpptest/out" in line]
    assert published, "the MQTT output published nothing"
    assert any(line.endswith(" 50 50") for line in published), f"payloads: {published[-5:]}"


def test_multicast_follows_a_new_address_that_arrives_before_the_old_goes(fppd):
    """When the output interface gets its new address before losing the old
    one (a DHCP lease replacing a fallback address), multicast carries on
    from the new address. The new address is on another subnet, as a lease
    replacing a 169.254 address is: one on the same subnet would be a
    secondary, which the kernel deletes with the primary unless
    promote_secondaries is set (it isn't in the container).

    Regression: 530aa8813. 6b40e5c79 handled an address arriving, not this
    order. NEW_ADDR was ignored because the interface was up, and DEL_ADDR
    marked it down and dropped the sockets without re-reading the address,
    so the frame thread rebuilt them bound to, and with IP_MULTICAST_IF on,
    the deleted address. Both failed (bind errno 99), the packets followed
    the routing table out of another interface, and nothing reached fpptd0
    until some later NEW_ADDR.
    """
    from capture import UdpCapture

    address_less_interface()
    try:
        ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
            "interface": ADDR_IFACE, "universes": [output(0, 1, 1, 510)]}]})
        fppd.settings(DisableFakeNetworkBridges="1")
        with UdpCapture(E131_PORT, dst_ip="239.255.0.1", iface=ADDR_IFACE) as cap:
            fppd.start()
            fppd.request("PUT", "/overlays/range/1-510", {"Value": 42})
            fppd.wait_for(lambda: "10.66.0.1" in sources_since(cap, time.monotonic() - 1),
                          timeout=10, what="multicast from 10.66.0.1")
            ip("addr", "add", "10.66.1.2/24", "dev", ADDR_IFACE)
            time.sleep(1)
            ip("addr", "del", "10.66.0.1/24", "dev", ADDR_IFACE)
            fppd.wait_for(lambda: sources_since(cap, time.monotonic() - 1) == {"10.66.1.2"},
                          timeout=10, what="multicast from 10.66.1.2 on the interface")
    finally:
        ip("link", "del", ADDR_IFACE)


def test_invalid_interface_warning_comes_down_when_the_address_arrives(fppd):
    """An output interface with no address yet raises "Invalid interface for
    UDP broadcast/multicast"; once its address arrives and multicast flows
    from it, the warning comes down.

    Also guards f56a4f5a3, which added the warning: before it an interface
    with no address was reported as 127.0.0.1 and nothing was raised.

    Regression: 1de28213c. The NEW_ADDR recovery 6b40e5c79 added brought the
    output up but never removed warning 22; it came down only at the next
    co-universes.json load, and where the interface fell back to a default
    it stayed for the life of the process.
    """
    from capture import UdpCapture

    address_less_interface()
    try:
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
            "interface": ADDR_IFACE, "universes": [output(0, 1, 1, 510)]}]})
        fppd.settings(DisableFakeNetworkBridges="1")

        def warned():
            return [w for w in fppd.get("/fppd/status").get("warnings", [])
                    if "Invalid interface for UDP broadcast/multicast" in w]

        with UdpCapture(E131_PORT, dst_ip="239.255.0.1", iface=ADDR_IFACE) as cap:
            fppd.start()
            fppd.request("PUT", "/overlays/range/1-510", {"Value": 42})
            fppd.wait_for(warned, timeout=10, what="the invalid-interface warning")
            ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
            fppd.wait_for(lambda: "10.66.0.1" in sources_since(cap, time.monotonic() - 1),
                          timeout=10, what="multicast from 10.66.0.1")
            fppd.wait_for(lambda: not warned(), timeout=15, interval=0.5,
                          what="the invalid-interface warning to come down")
    finally:
        ip("link", "del", ADDR_IFACE)


def default_route_interface():
    r = ip("-o", "route", "show", "default")
    words = r.stdout.split()
    if "dev" not in words:
        pytest.skip("no default route")
    return words[words.index("dev") + 1]


def test_generic_udp_to_a_multicast_group_keeps_sending(fppd):
    """A Generic UDP output to a multicast group (239.255.50.1) is not
    pinged when the output interface loses its address and gets it back (a
    DHCP renewal, a cable pulled and replaced), which pings every
    controller: 40 s on it still sends every frame and raises no
    unreachable-controller warning. (At the fix's parent it was dropped
    within 20 s.)

    The group's packets leave by whichever interface the socket's source
    address picks, so both the output interface and the default route's
    are captured.

    Regression: bd0bc3c9f. The multicast check could never match (first
    octet >= 239 and <= 224, read from the wrong end of the address), so the
    group was pinged like a controller; nothing answers a ping to a group,
    and once three pings and an HTTP probe had failed the output was marked
    invalid and stopped sending. Since e2422ff8e GenericUDP outputs are
    attached after the UDP output collects its ping hosts and are never
    pinged at all, so on master this passes with the fix reverted: it is
    red only at the fix's parent.
    """
    from capture import UdpCapture

    group, port = "239.255.50.1", 9124
    address_less_interface()
    try:
        entry = output(1, 1, 1, 10)  # the UDP output Generic UDP sends through
        entry["address"] = "10.66.0.2"
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 10,
            "interface": ADDR_IFACE, "universes": [entry]}]})
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 30,
            "description": "group", "address": group, "port": port, "tokens": "{data}"}]})
        fppd.settings(DisableFakeNetworkBridges="1")

        def unreachable():
            return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                    if w.get("id") == 27 and group in str(w)]

        with UdpCapture(port, dst_ip=group, iface=ADDR_IFACE) as show, \
                UdpCapture(port, dst_ip=group, iface=default_route_interface()) as other:
            def sent_since(t):
                return sum(1 for cap in (show, other) for at, *_ in cap.snapshot() if at >= t)

            ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
            fppd.start()
            fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
            time.sleep(1)
            ip("addr", "del", "10.66.0.1/24", "dev", ADDR_IFACE)
            time.sleep(1)
            ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)  # pings every controller
            fppd.wait_for(lambda: sent_since(time.monotonic() - 1) >= 5, timeout=15,
                          what=f"Generic UDP packets to {group} once the interface is up")
            end = time.monotonic() + 40
            while time.monotonic() < end:
                time.sleep(1)
                assert not unreachable(), f"the multicast group was pinged and dropped: {unreachable()}"
                recent = sent_since(time.monotonic() - 1)
                assert recent >= 5, f"{recent} Generic UDP packets to {group} in the last second"
    finally:
        ip("link", "del", ADDR_IFACE)


def test_generic_udp_multicast_leaves_by_the_output_interface(fppd):
    """A Generic UDP output to a multicast group sends out of the UDP
    output's interface (fpptd0), not by the default route.

    Regression: 394680df9. Generic UDP packets were grouped by their
    destination address, not with the other multicast, so the socket they
    went out on had no IP_MULTICAST_IF and followed the default route:
    devices on the show network never saw them.
    """
    from capture import UdpCapture

    group, port = "239.255.50.1", 9124
    address_less_interface()
    try:
        ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
        entry = output(1, 1, 1, 10)  # the UDP output Generic UDP sends through
        entry["address"] = "10.66.0.2"
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 10,
            "interface": ADDR_IFACE, "universes": [entry]}]})
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 30,
            "description": "group", "address": group, "port": port, "tokens": "{data}"}]})
        fppd.settings(DisableFakeNetworkBridges="1")
        with UdpCapture(port, dst_ip=group, iface=ADDR_IFACE) as show:
            fppd.start()
            fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
            fppd.wait_for(lambda: len(show.snapshot()) >= 5, timeout=10,
                          what=f"Generic UDP packets to {group} on {ADDR_IFACE}")
    finally:
        ip("link", "del", ADDR_IFACE)


def test_an_unreachable_generic_udp_controller_is_flagged_until_its_output_goes(fppd):
    """A Generic UDP output to a unicast address nothing answers raises the
    unreachable-controller warning, as an E1.31 or DDP output to it would,
    and deleting the output takes the warning down.

    Regression: e801353d8. Since e2422ff8e Generic UDP outputs attach to the
    UDP output after it has collected the controllers it pings, so theirs
    were never pinged: one that went offline was never flagged, nor taken
    out of the frame.
    """
    target, port = "10.66.0.9", 9124
    address_less_interface()
    try:
        ip("addr", "add", "10.66.0.1/24", "dev", ADDR_IFACE)
        entry = output(1, 1, 1, 10)
        entry["address"] = "10.66.0.2"
        entry["active"] = 0  # the UDP output Generic UDP sends through; nothing of its own
        fppd.write("config/co-universes.json", {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 10,
            "interface": ADDR_IFACE, "universes": [entry]}]})
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 30,
            "description": "offline", "address": target, "port": port, "tokens": "{data}"}]})
        fppd.settings(DisableFakeNetworkBridges="1")

        def unreachable():
            return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                    if w.get("id") == 27 and target in str(w)]

        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
        # three pings 15 s apart and an HTTP probe between them have to fail
        fppd.wait_for(unreachable, timeout=75, interval=1,
                      what=f"the unreachable-controller warning for {target}")
        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-other.json", {"channelOutputs": []})
        fppd.wait_for(lambda: not unreachable(), timeout=10,
                      what="the warning to come down with the output")
    finally:
        ip("link", "del", ADDR_IFACE)


def e131_sync_capture(fppd, seconds=3):
    """Play a sequence to an E1.31 universe with sync universe 7, unicast
    to a Listener here; return (data packets, sync packets). The sync
    packets leave by the default route (no output interface is set), where
    they are captured."""
    from capture import UdpCapture

    frames = unique_frames(80, 510)
    with Listener(E131_PORT) as rx, \
            UdpCapture(E131_PORT, dst_ip="239.255.0.7", iface=default_route_interface()) as sync:
        play(fppd, frames, [output(1, 1, 1, 510, syncUniverse=7)])
        time.sleep(seconds)
        data = [p for p in packets(rx) if parse_e131(p)]
        captured = [p for _, _, _, p in sync.snapshot()]
    # off a real interface each packet shows twice, leaving and looped back
    return data, [p for i, p in enumerate(captured) if i == 0 or p != captured[i - 1]]


def test_e131_sync_universe_on_the_wire(fppd):
    """An E1.31 output with a sync universe (7) names it in every data
    packet's synchronization address, and sends E1.31 synchronization
    packets to 239.255.0.7, about one a frame: 49 bytes, root vector
    VECTOR_ROOT_E131_EXTENDED, framing vector
    VECTOR_E131_EXTENDED_SYNCHRONIZATION, flags and lengths that cover the
    packet, and the sync address 7.

    Regression: 8d7929296 (the feature). Before it the sync address was
    always 0 and no sync packet was sent.
    """
    data, syncs = e131_sync_capture(fppd)
    assert len(data) > 30, f"only {len(data)} E1.31 data packets arrived"
    addrs = {struct.unpack(">H", p[109:111])[0] for p in data}
    assert addrs == {7}, f"data packets' synchronization addresses: {sorted(addrs)}"
    assert len(syncs) > 30, f"only {len(syncs)} sync packets to 239.255.0.7"
    for p in syncs:
        assert len(p) == 49, f"a {len(p)}-byte sync packet: {p.hex()}"
        assert p[4:16] == ACN_ID, p.hex()
        assert struct.unpack(">H", p[16:18])[0] == 0x7000 | (49 - 16), p.hex()
        assert struct.unpack(">I", p[18:22])[0] == 0x00000008, p.hex()
        assert struct.unpack(">H", p[38:40])[0] == 0x7000 | (49 - 38), p.hex()
        assert struct.unpack(">I", p[40:44])[0] == 0x00000001, p.hex()
        assert struct.unpack(">H", p[45:47])[0] == 7, p.hex()


def test_e131_sync_sequence_counts_by_one(fppd):
    """E1.31 sync packets' sequence number counts up by exactly one per
    packet, like a universe's, from the start of playback.

    Regression: 256b0cf8e (its sync half). The sync sequence number was
    advanced when the frame was prepared, so a frame prepared twice as
    playback started skipped one (1, 3, 4, 5, 7, ...).
    """
    _, syncs = e131_sync_capture(fppd)
    assert len(syncs) > 30, f"only {len(syncs)} sync packets to 239.255.0.7"
    check_sequence_numbers([p[44] for p in syncs], "sync universe 7")


def test_bridge_joins_the_sync_universe_its_senders_name(fppd):
    """E1.31 data arriving unicast for an input universe, naming sync
    universe 9 (which is not an input universe), makes the bridge join
    239.255.0.9, so the sender's multicast sync packets reach it: the
    bridge's stats count them as "E1.31 Sync".

    The sync packets are sent out of the default route's interface with
    multicast loopback on, which delivers them to this machine's members of
    the group; the bridge joins on every interface but loopback.

    Regression: 8d7929296 (the input half of the feature). The bridge
    joined only its input universes' groups, so sync sent to another
    universe never arrived and was never counted.
    """
    import socket

    from test_bridge_inputs import inputs, raw_output, udp_outputs
    from packets import e131 as e131_packet

    fppd.write("config/co-universes.json", udp_outputs())
    fppd.write("config/co-other.json", raw_output())
    fppd.write("config/ci-universes.json", inputs())
    iface = default_route_interface()
    addr = ip("-o", "-4", "addr", "show", "dev", iface).stdout.split()
    local = addr[addr.index("inet") + 1].split("/")[0]

    def sync_packet(seq):
        return (struct.pack(">HH", 0x0010, 0) + ACN_ID + struct.pack(">HI", 0x7000 | 33, 8)
                + b"fpp-tests-cid-01" + struct.pack(">HIBH", 0x7000 | 11, 1, seq & 0xFF, 9) + b"\0\0")

    def synced():
        return next((int(u["packetsReceived"]) for u in fppd.get("/fppd/e131stats")["universes"]
                     if u["id"] == "E1.31 Sync"), 0)

    mc = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    mc.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(local))
    mc.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
    try:
        fppd.start()
        data = bytes([0x20]) * 100
        with Sender(lambda n: [(e131_packet(10, data, seq=n, sync_universe=9), E131_PORT)]):
            n = 0
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not synced():
                mc.sendto(sync_packet(n), ("239.255.0.9", E131_PORT))
                n += 1
                time.sleep(0.05)
            assert synced(), f"none of {n} sync packets to 239.255.0.9 reached the bridge"
    finally:
        mc.close()
