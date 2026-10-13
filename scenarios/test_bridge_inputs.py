"""The network input bridge: E1.31, Art-Net and DDP arriving at fppd and
going back out on its outputs.

Packets are built from the protocol specs (packets.py) and streamed to fppd
on 127.0.0.1. A GenericUDP output sends the whole bridged channel range,
raw, to a Listener here, so every check reads exactly what a controller
behind fppd would get.
"""

import os
import time

import pytest

from fseq import solid_frames, write_fseq
from packets import (ARTNET_PORT, DDP_PORT, E131_PORT, Sender, artdmx, ddp, e131, send)
from show import playlist, sequence_entry
from udp import Listener

OUT_PORT = 5000
CHANNELS = 700

# Inputs: E1.31 universes 10 and 11 (one entry, universeCount 2) on
# channels 101-300, Art-Net universe 5 on 401-450. DDP needs no config.
E131_START, E131_SIZE = 101, 100
ARTNET_UNIVERSE, ARTNET_START, ARTNET_SIZE = 5, 401, 50


def raw_output(channels=CHANNELS):
    """co-other.json: channels 1..N sent raw, one packet a frame."""
    return {"channelOutputs": [{
        "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": channels,
        "description": "raw", "address": "127.0.0.1", "port": OUT_PORT, "tokens": "{data}",
    }]}


def inputs(timeout=None, e131_id=10, e131_start=E131_START):
    entry = {
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [
            {"active": 1, "id": e131_id, "universeCount": 2, "startChannel": e131_start,
             "channelCount": E131_SIZE, "type": 1, "priority": 0, "address": ""},
            {"active": 1, "id": ARTNET_UNIVERSE, "startChannel": ARTNET_START,
             "channelCount": ARTNET_SIZE, "type": 3, "priority": 0, "address": ""},
        ],
    }
    if timeout is not None:
        entry["timeout"] = timeout
    return {"channelInputs": [entry]}


def udp_outputs():
    """co-universes.json. GenericUDP rides on the E1.31/DDP output, which
    only exists while this config has an enabled entry: one E1.31 channel
    to an address nothing answers (TEST-NET-1), never pinged."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 1,
        "universes": [{"active": 1, "description": "nowhere", "id": 1, "startChannel": 1,
                       "channelCount": 1, "type": 1, "address": "192.0.2.1", "priority": 0,
                       "monitor": 0, "deDuplicate": 0}],
    }]}


def setup(fppd, **kw):
    fppd.write("config/co-universes.json", udp_outputs())
    fppd.write("config/co-other.json", raw_output())
    fppd.write("config/ci-universes.json", inputs(**kw))


def last(listener):
    with listener.lock:
        for _, data in reversed(listener.packets):
            if len(data) == CHANNELS:
                return data
    return bytes(CHANNELS)


def wait_output(fppd, out, predicate, what, timeout=10):
    """Wait until the latest output packet satisfies `predicate`; return it."""
    def check():
        f = last(out)
        return f if predicate(f) else None
    return fppd.wait_for(check, timeout=timeout, interval=0.05, what=what)


def region(frame, start, size):
    """Channels start..start+size-1 (1-based) of a frame."""
    return frame[start - 1:start - 1 + size]


def stats(fppd):
    return {str(u["id"]): u for u in fppd.get("/fppd/e131stats")["universes"]}


def test_each_protocol_lands_on_its_channels(fppd):
    """E1.31 (both universes of a universeCount entry), Art-Net and DDP each
    put their data on the channels configured for them, and nothing else
    on the output changes."""
    setup(fppd)
    u10, u11 = bytes([0x10]) * E131_SIZE, bytes([0x11]) * E131_SIZE
    art = bytes([0x55]) * ARTNET_SIZE
    dd = bytes(range(1, 31))

    def packets(n):
        return [(e131(10, u10, seq=n), E131_PORT), (e131(11, u11, seq=n), E131_PORT),
                (artdmx(ARTNET_UNIVERSE, art, seq=n), ARTNET_PORT),
                (ddp(600, dd, seq=n % 15 + 1), DDP_PORT)]

    expected = bytearray(CHANNELS)
    expected[100:200] = u10
    expected[200:300] = u11
    expected[400:450] = art
    expected[600:630] = dd
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(packets):
            frame = wait_output(fppd, out, lambda f: f == bytes(expected),
                                "every input on its channels")
        s = stats(fppd)
        assert int(s["10"]["packetsReceived"]) > 0 and int(s["11"]["packetsReceived"]) > 0
        assert int(s[str(ARTNET_UNIVERSE)]["packetsReceived"]) > 0


def test_bridged_data_expires_when_the_source_stops(fppd):
    """When packets stop, the bridged channels go dark after the input's
    timeout (1 s by default) -- not frozen on the last packet."""
    setup(fppd)
    data = bytes([0x7F]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                        "the E1.31 data")
        stopped = time.monotonic()
        wait_output(fppd, out, lambda f: not any(f), "the bridged channels to go dark", timeout=5)
        assert time.monotonic() - stopped < 3


def test_input_timeout_is_honoured(fppd):
    """A longer input timeout keeps the last data up for that long."""
    setup(fppd, timeout=4000)
    data = bytes([0x7F]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                        "the E1.31 data")
        stopped = time.monotonic()
        time.sleep(2.5)
        assert region(last(out), E131_START, E131_SIZE) == data, \
            "the data expired before the 4 s timeout"
        wait_output(fppd, out, lambda f: not any(f), "the data to expire", timeout=6)
        assert time.monotonic() - stopped >= 3.5


def play_solid_sequence(fppd, value):
    seq = solid_frames(600, CHANNELS, value)  # 30 s
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), seq, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    return seq


def test_a_playing_sequence_wins_by_default(fppd):
    """By default (bridgeDataPriority "Warn If Sequence Running") bridged
    input does not reach the output while a sequence plays, and fppd raises
    a warning that it is arriving."""
    setup(fppd)
    seq = play_solid_sequence(fppd, 0x03)
    data = bytes([0xE0]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_output(fppd, out, lambda f: f == seq[0], "the sequence")
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            fppd.wait_for(lambda: any("bridging data while sequence is running" in w
                                      for w in fppd.get("/fppd/status").get("warnings", [])),
                          what="the bridging-while-playing warning")
            for _ in range(20):
                assert last(out) == seq[0], "bridged data got over the sequence"
                time.sleep(0.05)


def test_bridged_data_over_a_playing_sequence(fppd):
    """With bridgeDataPriority "Prioritize Bridge", bridged input overrides
    a playing sequence on its channels only, and the sequence shows there
    again once the input stops."""
    setup(fppd)
    fppd.settings(bridgeDataPriority="Prioritize Bridge")
    seq = play_solid_sequence(fppd, 0x03)
    data = bytes([0xE0]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        wait_output(fppd, out, lambda f: f == seq[0], "the sequence")
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            frame = wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                                "the bridged data over the sequence")
            rest = frame[:E131_START - 1] + frame[E131_START - 1 + E131_SIZE:]
            assert set(rest) == {0x03}, "bridged data disturbed the sequence elsewhere"
        wait_output(fppd, out, lambda f: f == seq[0], "the sequence back once the input stopped",
                    timeout=5)


def test_short_packet_updates_only_what_it_carries(fppd):
    """An E1.31 packet carrying fewer channels than its universe is
    configured for sets only those channels.

    Regression: 6a07e63db. The bridge copied the configured universe size
    from its receive buffer whatever the packet's length, so the channels
    past a short packet's end got stale bytes left there by an earlier,
    longer packet.
    """
    setup(fppd)
    stale = bytes([0xEE]) * E131_SIZE
    short = bytes([0x22]) * 10

    def packets(n):
        # Alternate rounds, far enough apart that each packet is read on its
        # own: then every one lands in the same receive buffer, and a short
        # universe 10 packet follows a full universe 11 packet into it.
        if n % 2:
            return [(e131(10, short, seq=n // 2), E131_PORT)]
        return [(e131(11, stale, seq=n // 2), E131_PORT)]

    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(packets, interval=0.02):
            wait_output(fppd, out, lambda f: region(f, E131_START, 10) == short,
                        "the short packet's channels")
            for _ in range(40):
                tail = region(last(out), E131_START + 10, E131_SIZE - 10)
                assert not any(tail), \
                    f"channels past the short packet's end were set: {sorted(set(tail))}"
                time.sleep(0.05)


def test_priority_picks_the_higher_source_and_fails_over(fppd):
    """With BridgeSourcePriority on, two senders on one universe don't fight:
    the higher E1.31 priority wins and the other is counted as suppressed;
    when the winner stops, the other takes over after the timeout (3b74aa0aa)."""
    setup(fppd)
    fppd.settings(BridgeSourcePriority="1")
    hi = bytes([0xAA]) * E131_SIZE
    lo = bytes([0x55]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(e131(10, lo, seq=n, priority=50, cid=b"source-low"), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == lo, "the low source")
            with Sender(lambda n: [(e131(10, hi, seq=n, priority=150, cid=b"source-high"), E131_PORT)]):
                wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == hi,
                            "the higher-priority source to take over")
                # and it keeps the universe: no flicker back to the low one
                for _ in range(30):
                    assert region(last(out), E131_START, E131_SIZE) == hi, \
                        "the lower-priority source got through"
                    time.sleep(0.05)
                assert int(stats(fppd)["10"]["suppressedPackets"]) > 0
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == lo,
                        "the low source to take over once the high one stopped", timeout=5)


def test_sequence_gaps_are_counted_as_errors(fppd):
    """The per-universe stats count packets and sequence-number gaps, and
    DELETE /fppd/e131stats clears them."""
    setup(fppd)
    fppd.start()
    data = bytes(E131_SIZE)
    send([e131(10, data, seq=n) for n in range(1, 21)], E131_PORT)
    fppd.wait_for(lambda: stats(fppd)["10"]["packetsReceived"] == "20", what="20 packets counted")
    assert stats(fppd)["10"]["errors"] == "0"
    send([e131(10, data, seq=n) for n in (23, 24, 30)], E131_PORT)
    fppd.wait_for(lambda: stats(fppd)["10"]["packetsReceived"] == "23", what="23 packets counted")
    assert stats(fppd)["10"]["errors"] == "2"
    # 255 wraps to 0 or 1 without an error
    send([e131(10, data, seq=n) for n in (254, 255, 0, 1)], E131_PORT)
    fppd.wait_for(lambda: stats(fppd)["10"]["packetsReceived"] == "27", what="27 packets counted")
    assert stats(fppd)["10"]["errors"] == "3"  # only the jump 30 -> 254

    fppd.request("DELETE", "/fppd/e131stats")
    assert stats(fppd)["10"]["packetsReceived"] == "0"


MAX = 8192 * 1024  # FPPD_MAX_CHANNELS


def malformed():
    good = bytes([0x44]) * 20
    full = e131(10, good)
    return {
        "DDP past the end of channel space": (ddp(MAX - 10, good), DDP_PORT),
        "DDP into the reserved channels": (ddp(MAX, good), DDP_PORT),
        "DDP at offset 4G": (ddp(0xFFFFFFF0, good), DDP_PORT),
        "DDP longer than the packet": (ddp(0, good, length=1400), DDP_PORT),
        "DDP header cut short": (ddp(0, good)[:7], DDP_PORT),
        "DDP three bytes": (b"\x41\x01\x01", DDP_PORT),
        "E1.31 cut inside the header": (full[:100], E131_PORT),
        "E1.31 count larger than the packet": (e131(10, good, count=513), E131_PORT),
        "E1.31 count zero": (e131(10, good, count=0), E131_PORT),
        "E1.31 universe 65535": (e131(65535, good), E131_PORT),
        "E1.31 extended packet cut short": (full[:22], E131_PORT),
        "Art-Net length past the packet": (artdmx(ARTNET_UNIVERSE, good, length=0x7FFF), ARTNET_PORT),
        "Art-Net header cut short": (artdmx(ARTNET_UNIVERSE, good)[:15], ARTNET_PORT),
        "Art-Net universe 32767": (artdmx(0x7FFF, good), ARTNET_PORT),
    }


@pytest.mark.parametrize("what", list(malformed()))
def test_malformed_packet_is_survived(fppd, what):
    """A malformed or hostile packet, sent a few hundred times, writes
    nothing outside the channel buffer and leaves the bridge working.
    (Regressions: e671aa43c, 6a07e63db, f53085a75.)"""
    setup(fppd)
    pkt, port = malformed()[what]
    good = bytes([0x66]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        send([pkt] * 300, port)
        time.sleep(0.5)
        with Sender(lambda n: [(e131(10, good, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == good,
                        "good data through the bridge afterwards")


def test_input_config_reloaded_under_traffic(fppd):
    """Saving ci-universes.json over and over while packets stream in never
    lands a packet in a half-built universe table, and the last save is the
    one that holds (6a07e63db)."""
    setup(fppd)
    data = bytes([0x99]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT), (e131(20, data, seq=n), E131_PORT),
                               (ddp(0, data, seq=n % 15 + 1), DDP_PORT)], interval=0.005):
            for i in range(30):
                fppd.write("config/ci-universes.json",
                           inputs(e131_id=10 if i % 2 else 20, e131_start=E131_START + 100 * (i % 3)))
                time.sleep(0.2)
            # last save: i = 29 -> universe 10 at 101 + 200 = 301
            fppd.write("config/ci-universes.json", inputs(e131_id=10, e131_start=301))
            wait_output(fppd, out, lambda f: region(f, 301, E131_SIZE) == data,
                        "the last saved input config to hold")


def test_clock_step_back_does_not_freeze_bridged_data(fppd):
    """Bridged data still expires on time when the wall clock steps back
    while it is up (an NTP correction, an RTC that boots in the past).

    Regression: 3ea54ba41. Bridged ranges were stamped with the packets'
    wall-clock time plus the timeout and expired against the wall clock, so
    a step back kept the last frame up for as long as the step (an hour
    here). It also needs 9924238da: before it, the output thread itself
    stopped sending for as long as the step.
    """
    setup(fppd)
    data = bytes([0x7F]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start(fake_time="2026-12-24 18:00:00")
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                        "the E1.31 data")
        # The step lands after the last packet and before it expires, so
        # that packet's expiry was stamped before the step.
        fppd.set_clock("2026-12-24 17:00:00")
        wait_output(fppd, out, lambda f: not any(f), "the bridged data to expire", timeout=5)
