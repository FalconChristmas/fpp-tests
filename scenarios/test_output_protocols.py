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
from packets import ARTNET_PORT, DDP_PORT, E131_PORT, parse_artdmx, parse_e131
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
