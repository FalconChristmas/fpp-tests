"""Virtual strings with start nulls, on the bytes PRU1 is handed (AM62x).

Device only: run with run-local.sh --host-pru on a PocketBeagle2. Skipped
elsewhere.
"""

import time

import pru
from bbcape import pixel_output, strings_config, write_string_cape
from packets import DDP_PORT, Sender, ddp
from pru import real_pru  # noqa: F401 (a fixture)


def planes(wire):
    """What the shift firmware is handed for one string on data pin 0, shift
    stage 0: per byte, 8 bit planes (most significant first) of 8 stage
    bytes, bit 0 of each stage byte being pin 0."""
    out = bytearray()
    for b in wire:
        for j in range(8):
            plane = bytearray(8)
            plane[0] = (b >> (7 - j)) & 1
            out += plane
    return bytes(out)


def test_a_virtual_string_with_start_nulls_keeps_its_channel_count(real_pru, fppd):
    """One port made of two virtual strings, the first with two start null
    nodes: the port sends the first string's nulls and then its pixels,
    ahead of anything from the second string.

    Regression: d3e09f8b3. The first string's channel count was taken from
    after its start nulls, so it sent only 6 of its 12 bytes (just the
    nulls, none of its pixels) and the second string's pixels moved up into
    their place.

    The cape under run-local.sh is unsigned, so the port is clamped to 50
    pixels; the clamp must keep the null nodes in the port's byte count or
    the last string's bytes fall off the end of the frame.
    """
    outs = [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]
    write_string_cape("TestNulls", {"driver": "BBShiftString", "outputs": outs})
    port = pixel_output(0, 2, 0)
    port["virtualStrings"][0]["nullNodes"] = 2
    second = dict(port["virtualStrings"][0], description="second", startChannel=6, pixelCount=2, nullNodes=0)
    port["virtualStrings"].append(second)
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestNulls", [port], channels=12))
    # DDP is bridged to channels 1-12 once an input is configured
    fppd.write("config/ci-universes.json", {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 12,
        "universes": [{"active": 1, "id": 10, "universeCount": 1, "startChannel": 1,
                       "channelCount": 12, "type": 1, "priority": 0, "address": ""}]}]})
    fppd.start(timeout=60)
    data = bytes([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC])
    wire = bytes(6) + data  # the nulls, then both strings' pixels
    with Sender(lambda n: [(ddp(0, data, seq=n % 15 + 1), DDP_PORT)], interval=0.02):
        time.sleep(4)
        with pru.Pruss() as p:
            base, size = p.dram(1, pru.RING_CONFIG), p.dram(1, pru.RING_CONFIG + 4)
            # the ring reads empty once the firmware has shifted a frame
            # out: with PRU1 halted the next frame is written and stays
            assert p.halt(1), "PRU1 did not halt"
            time.sleep(0.5)
            ring = p.read(pru.SHARED + base - pru.SHARED_PRU_ADDR, size)
            assert p.resume(1), "PRU1 did not stay running"
    # the frame may wrap round the end of the ring: look in two laps
    nz = [(i // 64, hex(sum((ring[i + j * 8] & 1) << (7 - j) for j in range(8)))) for i in range(0, len(ring) - 63, 64)
          if any(ring[i:i + 64])]
    assert planes(wire) in ring + ring, \
        f"ring {base:#x}+{size}: {len(nz)} nonzero positions {nz[:24]}"
