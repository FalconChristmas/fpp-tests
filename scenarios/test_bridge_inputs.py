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
from show import ddp_output, playlist, sequence_entry
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


def test_dmx_serial_input_lands_on_its_channels(fppd):
    """DMX arriving on a serial input (ci-dmx.json) is bridged to its start
    address: a frame is a 0 start code and up to 512 slots, told apart by
    the break before it (here a gap of over 3 ms between writes). Only the
    configured channel count is used, and the stats count the frames."""
    import os
    import threading
    from serial import PtyReader
    with PtyReader() as pty, Listener(OUT_PORT) as out:
        fppd.write("config/co-universes.json", udp_outputs())
        fppd.write("config/co-other.json", raw_output())
        fppd.write("config/ci-dmx.json", {"channelInputs": [{
            "type": "dmx", "enabled": 1, "device": pty.device,
            "startAddress": 501, "channelCount": 100}]})
        fppd.start()
        slots = bytes((i % 200) + 20 for i in range(512))
        sending = threading.Event()
        sending.set()

        def sender():
            while sending.is_set():
                os.write(pty.master, b"\x00" + slots)
                time.sleep(0.03)

        t = threading.Thread(target=sender, daemon=True)
        t.start()
        try:
            frame = wait_output(fppd, out, lambda f: region(f, 501, 100) == slots[:100],
                                "the DMX slots on channels 501-600")
            assert not any(frame[:500]) and not any(frame[600:]), "DMX data outside its 100 channels"
            dmx = [u for u in fppd.get("/fppd/e131stats")["universes"] if str(u["id"]) == pty.device]
            assert dmx and int(dmx[0]["packetsReceived"]) > 0, dmx
        finally:
            sending.clear()
            t.join()


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def test_artnet_input_starts_once_its_port_is_free(fppd):
    """ArtNet input configured while another program holds UDP 6454 starts
    working once the port is free, with no config save to prompt it.

    Regression: c972d01ba (BR-4). The ArtNet input handlers were added only
    if the port opened as the input config loaded, and nothing tried again:
    ArtNet input stayed dead until fppd restarted.
    """
    setup(fppd)
    data = bytes([0x5A]) * ARTNET_SIZE
    held = Listener(ARTNET_PORT, host="0.0.0.0")
    try:
        with Listener(OUT_PORT) as out:
            fppd.start()
            time.sleep(1)
            held.close()
            held = None
            with Sender(lambda n: [(artdmx(ARTNET_UNIVERSE, data, seq=n), ARTNET_PORT)]):
                wait_output(fppd, out, lambda f: region(f, ARTNET_START, ARTNET_SIZE) == data,
                            "ArtNet input once its port was free", timeout=20)
    finally:
        if held:
            held.close()


def test_artnet_and_e131_universes_of_one_number_stay_apart(fppd):
    """ArtNet universe 10 is not E1.31 universe 10: ArtNet data for a
    universe number only E1.31 is configured for lands nowhere.

    Regression: c972d01ba (BR-5). The input lookup matched the universe
    number alone, so the ArtNet packets wrote E1.31 universe 10's channels.
    """
    setup(fppd)
    control = bytes([0x5A]) * ARTNET_SIZE
    stray = bytes([0xAB]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(artdmx(10, stray, seq=n), ARTNET_PORT),
                               (artdmx(ARTNET_UNIVERSE, control, seq=n), ARTNET_PORT)]):
            wait_output(fppd, out, lambda f: region(f, ARTNET_START, ARTNET_SIZE) == control,
                        "the ArtNet universe that is configured")
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                got = region(last(out), E131_START, E131_SIZE)
                assert not any(got), "ArtNet universe 10 landed on E1.31 universe 10's channels"
                time.sleep(0.05)


def test_unconfigured_e131_from_many_sources_raises_a_few_warnings(fppd):
    """E1.31 arriving with no input configured raises a warning naming its
    source, for the first eight sources; the rest share one. Forty sources
    (the source address is whatever a packet says) raise nine.

    Regression: c972d01ba (BR-8). Every new source added its own warning,
    without limit: forty here.
    """
    import socket
    fppd.start()
    for n in range(2, 42):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.bind((f"127.0.0.{n}", 0))
            s.sendto(e131(10, bytes(10)), ("127.0.0.1", E131_PORT))
    fppd.wait_for(lambda: [w for w in warnings(fppd) if w.startswith("Received E1.31 data from")],
                  timeout=5, what="a warning about the E1.31 data")
    time.sleep(1)
    raised = [w for w in warnings(fppd) if w.startswith("Received E1.31 data from")]
    assert len(raised) <= 9, f"{len(raised)} warnings about E1.31 sources"


def test_dmx_input_device_warning_clears_when_the_input_goes(fppd):
    """A DMX input whose device can't be opened raises a warning, and
    saving the DMX input config without it takes the warning down.

    Regression: c972d01ba (BR-7). The warning was never removed.
    """
    def dmx(enabled):
        return {"channelInputs": [{"type": "dmx", "enabled": enabled, "device": "ttyNOPE",
                                   "startAddress": 1, "channelCount": 10}]}
    fppd.write("config/ci-dmx.json", dmx(1))
    fppd.start()
    fppd.wait_for(lambda: [w for w in warnings(fppd) if "Could not open DMX input device" in w],
                  timeout=10, what="the DMX device warning")
    fppd.write("config/ci-dmx.json", dmx(0))
    fppd.wait_for(lambda: not [w for w in warnings(fppd) if "Could not open DMX input device" in w],
                  timeout=10, what="the DMX device warning to clear")


def test_input_universes_are_capped_in_total(fppd):
    """Input rows are capped at 65536 universes in total, not only each:
    three rows of 65536 keep the first 65536, with a warning saying so.

    Regression: c972d01ba (BR-9). There was no cap across rows and no
    warning: a hundred such rows built millions of entries.
    """
    row = {"active": 1, "id": 1, "universeCount": 65536, "startChannel": 1,
           "channelCount": 512, "type": 1, "priority": 0, "address": ""}
    fppd.write("config/ci-universes.json", {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [dict(row) for _ in range(3)]}]})
    fppd.start()
    fppd.wait_for(lambda: [w for w in warnings(fppd) if "only the first 65536" in w],
                  timeout=10, what="the universe cap warning")


@pytest.mark.parametrize("port", [E131_PORT, 32320], ids=["e131", "multisync"])
def test_a_flood_of_input_does_not_hold_the_main_loop(fppd, port):
    """While packets arrive faster than fppd reads them, its main loop
    still gets to its other work: a save of the input config made during
    the flood takes effect. slowrecv.so makes each read on the main loop
    take 10 ms, so a sender in a loop here outruns it. The flood is E1.31
    input itself, or junk on the MultiSync port with E1.31 streaming
    alongside at a normal rate.

    Regression: 097a2c743. Each input handler (and MultiSync's) read its
    socket until it was empty, so a sender faster than fppd kept the main
    loop inside it for as long as the flood lasted: the config save was
    never picked up.
    """
    import socket
    import threading

    import shims
    setup(fppd)
    data = bytes([0xA5]) * E131_SIZE
    flood_packet = e131(10, data) if port == E131_PORT else b"FPPD\x01\x00\x00"
    flooding = threading.Event()

    def flood():
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            while flooding.is_set():
                for _ in range(100):
                    s.sendto(flood_packet, ("127.0.0.1", port))

    with Listener(OUT_PORT) as out:
        fppd.start(preload=[shims.build("slowrecv.c")], extra_env={"SLOWRECV_MS": "10"})
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                        "the E1.31 data before the flood")
            flooding.set()
            t = threading.Thread(target=flood, daemon=True)
            t.start()
            try:
                time.sleep(1)
                fppd.write("config/ci-universes.json", inputs(e131_start=301))
                wait_output(fppd, out, lambda f: region(f, 301, E131_SIZE) == data,
                            "the input config saved during the flood to take effect", timeout=6)
            finally:
                flooding.clear()
                t.join()


def ddp_drops():
    """Datagrams the kernel dropped on the DDP port's socket: the last field
    of its /proc/net/udp line, in this network namespace."""
    with open("/proc/net/udp") as f:
        next(f)
        for line in f:
            fields = line.split()
            if int(fields[1].split(":")[1], 16) == DDP_PORT:
                return int(fields[-1])
    raise AssertionError(f"no socket on UDP port {DDP_PORT}")


def ddp_rcvbuf():
    """The DDP socket's receive buffer, as ss reports it (skmem rb)."""
    import re
    import subprocess
    out = subprocess.run(["ss", "-u", "-a", "-n", "-m", "sport", "=", f":{DDP_PORT}"],
                         capture_output=True, text=True, check=True).stdout
    m = re.search(r"\brb(\d+)", out)
    assert m, out
    return int(m.group(1))


@pytest.mark.parametrize("when", ["at_start", "after_a_reload"])
def test_ddp_frames_wait_out_a_stalled_main_loop(fppd, when):
    """Two full frames of DDP that arrive while the main loop is stalled
    (fppd stopped here) are all still there when it gets back: 1440000
    channels of outputs make a DDP frame 1000 full packets, and the
    socket's buffer holds both frames -- sized when it is opened, or when
    an output save adds channels.

    Regression: 1e08a64b5. The DDP socket was sized by the number of E1.31 and Art-Net
    input universes, which DDP has none of, so it got the 512 KB floor:
    about 450 full packets. The kernel dropped the rest of the burst.
    """
    import signal
    top = 1440000
    big = ddp_output(top, address="192.0.2.9")
    big["channelOutputs"][0]["universes"][0]["deDuplicate"] = 1
    fppd.write("config/ci-universes.json", inputs())
    fppd.write("config/co-universes.json", big if when == "at_start" else udp_outputs())
    fppd.start()
    small = ddp_rcvbuf()
    if when == "after_a_reload":
        fppd.write("config/co-universes.json", big)
        fppd.wait_for(lambda: ddp_rcvbuf() > small, timeout=10,
                      what="the DDP buffer to grow with the outputs' channels")
    payload = bytes([0x5A]) * 1440
    burst = [ddp(off, payload, push=off + 1440 >= top, seq=f % 15 + 1)
             for f in range(2) for off in range(0, top, 1440)]
    before = ddp_drops()
    os.kill(fppd.proc.pid, signal.SIGSTOP)
    try:
        send(burst, DDP_PORT)
        dropped = ddp_drops() - before
    finally:
        os.kill(fppd.proc.pid, signal.SIGCONT)
    assert dropped == 0, \
        f"{dropped} of {len(burst)} DDP packets dropped (receive buffer {ddp_rcvbuf()} bytes)"


def udp_drops(port):
    """Datagrams the kernel dropped on fppd's socket on UDP `port`."""
    with open("/proc/net/udp") as f:
        next(f)
        for line in f:
            fields = line.split()
            if int(fields[1].split(":")[1], 16) == port:
                return int(fields[-1])
    raise AssertionError(f"no socket on UDP port {port}")


def udp_rcvbuf(port):
    """fppd's socket's receive buffer on UDP `port` (ss skmem rb)."""
    import re
    import subprocess
    out = subprocess.run(["ss", "-u", "-a", "-n", "-m", "sport", "=", f":{port}"],
                         capture_output=True, text=True, check=True).stdout
    m = re.search(r"\brb(\d+)", out)
    assert m, out
    return int(m.group(1))


def test_e131_frames_of_a_thousand_universes_wait_out_a_stalled_main_loop(fppd):
    """Two full frames of 1000 E1.31 universes that arrive while the main
    loop is stalled (fppd stopped here) are all still there when it gets
    back: the E1.31 socket's buffer is sized by the input universe count.

    Regression: 511c61fb6. Every bridge input socket asked for a flat
    512 KB (1 MB once the kernel doubles it), whatever the universe count:
    a little over a frame of these fit, and the kernel dropped the rest of
    the burst. Now ~4 KB a universe, set with SO_RCVBUFFORCE so a player's
    net.core.rmem_max (384 KB then) doesn't clamp it. (This container's
    rmem_max is 4 MB, so the clamp itself isn't what is shown here.)"""
    import signal
    universes = 1000
    fppd.write("config/ci-universes.json", {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [{"active": 1, "id": 1, "universeCount": universes, "startChannel": 1,
                       "channelCount": 512, "type": 1, "priority": 0, "address": ""}]}]})
    fppd.start()
    burst = [e131(u, bytes([u & 0xFF]) * 512, seq=f) for f in range(2) for u in range(1, universes + 1)]
    before = udp_drops(E131_PORT)
    os.kill(fppd.proc.pid, signal.SIGSTOP)
    try:
        send(burst, E131_PORT)
        dropped = udp_drops(E131_PORT) - before
    finally:
        os.kill(fppd.proc.pid, signal.SIGCONT)
    assert dropped == 0, \
        f"{dropped} of {len(burst)} E1.31 packets dropped (receive buffer {udp_rcvbuf(E131_PORT)} bytes)"


def test_stats_read_and_reset_while_packets_arrive(fppd):
    """E1.31, Art-Net and DDP input streaming in while the stats are read
    and cleared over and over from the API: each read is whole, a clear
    takes, and the counts carry on climbing after it.

    Regression: 9c455f653, under TSan. The per-universe counters and the
    DDP and E1.31 totals were plain integers bumped by the packet path on
    the main loop while the HTTP threads read them and zeroed them on a
    reset: a data race on each, which TSan reported on both sides.

    Regression: b215b5bdb, under TSan. 9c455f653 left the DDP channel range
    (ddpMinChannel, ddpMaxChannel) plain: written by the packet path, read
    by the stats reader, which TSan reported in 3 of 6 runs after it."""
    import threading
    setup(fppd)
    fppd.start()
    data = bytes([0x33]) * E131_SIZE

    def packets(n):
        return [(e131(10, data, seq=n), E131_PORT), (e131(11, data, seq=n), E131_PORT),
                (artdmx(ARTNET_UNIVERSE, data[:ARTNET_SIZE], seq=n), ARTNET_PORT),
                (ddp(600, data[:50], push=True, seq=n % 15 + 1), DDP_PORT)]

    errors = []
    stop = threading.Event()

    def poll(clear):
        while not stop.is_set():
            try:
                if clear:
                    fppd.request("DELETE", "/fppd/e131stats")
                else:
                    assert "10" in stats(fppd)
            except Exception as e:  # report it from the main thread
                errors.append(repr(e))
                return

    with Sender(packets, interval=0.002):
        fppd.wait_for(lambda: int(stats(fppd)["10"]["packetsReceived"]) > 0, what="E1.31 counted")
        threads = [threading.Thread(target=poll, args=(c,), daemon=True) for c in (False, False, True)]
        for t in threads:
            t.start()
        time.sleep(5)
        stop.set()
        for t in threads:
            t.join(10)
        assert not errors, errors
        fppd.request("DELETE", "/fppd/e131stats")
        fppd.wait_for(lambda: int(stats(fppd)["10"]["packetsReceived"]) > 0, what="counting after a clear")


def test_a_bridged_universe_goes_out_whole(fppd):
    """E1.31 packets for one universe arriving as fast as fppd takes them,
    each a whole universe of one value that alternates packet to packet:
    every frame that goes out carries the universe all of one value, never
    part from one packet and part from the next.

    Regression: 36dbc3e11, under TSan. The receive path copied each packet
    into the bridge buffer with no lock while the output thread copied the
    buffer's live ranges into the frame after letting go of the ranges
    lock: a data race on the buffer, and a packet landing mid-copy sent a
    universe half old, half new. (The buffer was also allocated by the
    first bridged packet while the output thread tested the pointer.)"""
    setup(fppd)
    a, b = bytes([0x11]) * E131_SIZE, bytes([0x22]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(lambda n: [(e131(10, a if k % 2 else b, seq=(2 * n + k) & 0xFF), E131_PORT)
                               for k in range(2)], interval=0.001):
            wait_output(fppd, out, lambda f: set(region(f, E131_START, E131_SIZE)) <= {0x11, 0x22},
                        "the bridged universe")
            time.sleep(5)
        with out.lock:
            frames = [d for _, d in out.packets]
    torn = [f for f in frames if len(set(region(f, E131_START, E131_SIZE))) > 1]
    assert not torn, f"{len(torn)} of {len(frames)} frames carried a torn universe"
