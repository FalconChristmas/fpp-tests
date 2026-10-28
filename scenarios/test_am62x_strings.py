"""BBShiftString and Falcon smart receivers on an AM62x board: cape configs
the driver must bound, and the Falcon V5 listener's receiver chains --
against PRUs that never answer (see bbcape.py), and under run-local.sh
--host-pru on the real PRUs (see pru.py).

Device only: run with run-local.sh on a PocketBeagle2. Skipped elsewhere.
"""

import ctypes
import mmap
import os
import re
import time

import pytest

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape
import pru
from pru import real_pru  # noqa: F401 (a fixture)
import shims


def warnings_of(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def shift_outputs(n=16):
    return [{"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)][:n]


def listener_cape(name, outputs):
    """A shift cape with a Falcon V5 listener; P1-29 is a listener pin the
    board has."""
    write_string_cape(name, {"driver": "BBShiftString",
                             "falconV5ListenerConfig": {"listenerPins": [{"pin": "P1-29"}]},
                             "outputs": outputs})


def test_a_negative_listener_mux_in_the_cape_config_is_taken_as_mux_0(fppd):
    """A cape config whose Falcon V5 port names falconV5ListenerMux -1
    starts its output, the mux taken as 0.

    Regression: 985134dff (the cape mux half; the reply-decoding bounds
    need a receiver on the wire). The negative mux compared as huge
    against the per-mux vector sizes, so addReceiverChain() pushed onto
    maxCount until memory ran out. Here fppd's data is capped at 512 MB so
    that ends in std::bad_alloc and a refused output, rather than the
    device's OOM killer.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    outs = shift_outputs()
    outs[0]["falconV5Listener"] = 0
    outs[0]["falconV5ListenerMux"] = -1
    listener_cape("TestMuxNeg", outs)
    ports = [pixel_output(n, 10, n * 30) for n in range(4)]
    ports[0]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestMuxNeg", ports))
    so = shims.build("co_datalimit.c")
    fppd.start(timeout=90, preload=[so], extra_env={"CO_DATALIMIT_MB": "512"})
    w = warnings_of(fppd)
    assert not any("Could not initialize output type BBShiftString" in x for x in w), w
    assert "sustainable ceiling" in fppd.log(), fppd.tail()


# ---- on the real PRUs (run-local.sh --host-pru) --------------------------------

# P2-25 and P2-27: lines 19 and 18 of the 601000.gpio controller, which no
# K16 or PocketScroller cape uses
MUX_PINS = ("P2-25", "P2-27")
MUX_GPIO = 0x601000
MUX_LINES = (19, 18)


def held_lines(names):
    """Which of the named GPIO lines ("P2.25") something already holds, from
    gpiolib's debugfs listing (mounted here if need be)."""
    path = "/sys/kernel/debug/gpio"
    if not os.path.exists(path):
        os.system("mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null")
    try:
        with open(path) as f:
            text = f.read()
    except OSError:
        pytest.skip("no gpio debugfs to check the mux pins are free")
    return [n for n in names if re.search(r"\(" + re.escape(n) + r"[^|)]*\|", text)]


def gpio_driven(base, lines):
    """What a davinci GPIO controller at `base` drives on each of `lines`
    (0-31): its output data register, which holds the level fppd set
    whether or not the pad is muxed to GPIO."""
    fd = os.open("/dev/mem", os.O_RDONLY | os.O_SYNC)
    try:
        mm = mmap.mmap(fd, 4096, mmap.MAP_SHARED, mmap.PROT_READ, offset=base)
    finally:
        os.close(fd)
    try:
        out = ctypes.c_uint32.from_buffer_copy(mm[0x14:0x18]).value
    finally:
        mm.close()
    return tuple((out >> n) & 1 for n in lines)


def test_the_listener_mux_scheduler_comes_back_round_to_mux_0(real_pru, fppd):
    """Falcon V5 chains on three listener muxes (0, 1, 2), selected by two
    mux pins: as the query scheduler works through them the pins step
    00 -> 01 -> 10 and then back to 00 for the next round.

    Regression: 6f1a36abd. The current mux was held in a bool, so
    setCurrentMux(2) drove the pins to 10 but stored 1: from then on the
    scheduler asked for mux 2 every pass, the pins stayed at 10, and the
    receivers on mux 0 (and 1) were never polled again.

    The mux pins are lines no K16 or PocketScroller cape uses (skipped if
    something holds them); run-local.sh's
    stub pinctrl leaves their pads as they are, and the levels fppd drives
    are read back from the GPIO controller's output register.
    """
    held = held_lines(("P2.25", "P2.27"))
    if held:
        pytest.skip(f"{held} already in use on this cape")
    outs = shift_outputs()
    for mux in range(3):
        outs[mux * 4]["falconV5Listener"] = 0
        outs[mux * 4]["falconV5ListenerMux"] = mux
    write_string_cape("TestMux3", {"driver": "BBShiftString",
                                   "falconV5ListenerConfig": {"listenerPins": [{"pin": "P1-29"}],
                                                              "muxPins": list(MUX_PINS)},
                                   "outputs": outs})
    ports = [pixel_output(n, 10, n * 30) for n in range(12)]
    for mux in range(3):
        ports[mux * 4]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestMux3", ports))
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    seen = []
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        state = gpio_driven(MUX_GPIO, MUX_LINES)
        if not seen or seen[-1] != state:
            seen.append(state)
        if seen.count((0, 0)) >= 2 and (0, 1) in seen:
            break
        time.sleep(0.01)
    fppd.command("Test Stop")
    assert (1, 0) in seen and (0, 1) in seen, seen
    assert seen.count((0, 0)) >= 2, f"the mux pins never came back to 00: {seen}"


V5_RING = (0x3000, 20416)  # SMEM_RING_V5_BASE/SIZE, within the shared RAM


def test_falcon_v5_packets_leave_the_pins_with_no_strings_at_zero(real_pru, fppd):
    """With Falcon V5 chains querying, every block of the ring PRU1 shifts
    out -- pixel frames and the packet frames between them -- has the data
    pins the cape gives no strings (r30 bits 2-7 here) at zero.

    Regression: a051745c6 (the packet lanes; its stop/start half, a stale
    query slot resent after a restart, isn't visible from the ring).
    encodeFalconV5Packet() left its per-lane staging arrays uninitialised
    and filled only the lanes with a string mapped, but every lane is
    clocked out in the packet phase: the unused pins carried the output
    thread's old stack contents.
    """
    outs = shift_outputs()
    for n in (0, 4):
        outs[n]["falconV5Listener"] = 0
    listener_cape("TestV5Lanes", outs)
    ports = [pixel_output(n, 20, n * 60) for n in range(16)]
    for n in (0, 4):
        ports[n]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestV5Lanes", ports))
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(5)
    base, size = V5_RING
    stray = {}
    lit = 0
    with pru.Pruss() as p:
        frames = p.dram(1, pru.RING_FRAMES)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            for off in range(0, size, 4):
                w = p.shared(base + off)
                lit |= w
                if w & 0xFCFCFCFC:
                    stray.setdefault(off, w)
        frames = p.dram(1, pru.RING_FRAMES) - frames
    fppd.command("Test Stop")
    assert frames > 100, f"PRU1 rendered {frames} frames"
    assert lit & 0x03030303, "the ring never carried data on the string pins"
    assert not stray, f"{len(stray)} ring words with pins 2-7 set, e.g. " + \
        ", ".join(f"{o:#x}: {w:#010x}" for o, w in list(stray.items())[:8])


def save_strings(fppd, cfg):
    """Save co-bbbStrings.json the way the UI does, in one rename, so fppd
    reloads it once."""
    tmp = fppd.write("config/co-bbbStrings.json.new", cfg)
    os.replace(tmp, os.path.join(fppd.media, "config", "co-bbbStrings.json"))


def test_the_string_ring_never_needs_re_seating_across_reloads(real_pru, fppd):
    """16 ports of 50 pixels on PRU1 with a test pattern running, and the
    string config saved six times while it runs: the firmware never has to
    re-seat its ring read position on the frame start the pump publishes
    (its resync counter, SMEMRing.hp, stays 0 after every start), and it
    keeps rendering frames.

    Regression: 68bb4e993. A reloaded output could reach SendData() before
    its first PrepData(), and sent a zero-length command that the firmware
    still read one ring block for: every later frame sat one block (a byte
    per string) out, until fppd restarted. Since c6d86600e that is healed
    the next frame, and counted here.

    Regression: 7f8d8f634. The pump issued the next command as soon as the
    firmware had taken the previous one, while frame data could still be
    unread in the ring; that offset became a permanent skew (now a re-seat
    every time it happens).
    """
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    cfg = strings_config("BBShiftString", "TestShift16", [pixel_output(n, 50, n * 150) for n in range(16)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(6)
    resyncs = []
    with pru.Pruss() as p:
        for n in range(7):
            frames = p.dram(1, pru.RING_FRAMES)
            time.sleep(3)
            assert p.dram(1, pru.RING_FRAMES) - frames > 30, f"PRU1 stopped rendering after reload {n}"
            resyncs.append(p.dram(1, pru.RING_RESYNC))
            if n < 6:
                # the firmware restarts with the new output, clearing its counters
                save_strings(fppd, cfg)
                time.sleep(3)
    fppd.command("Test Stop")
    assert resyncs == [0] * 7, f"re-seats after the start and each of six reloads: {resyncs}"


def test_a_port_with_no_receiver_setting_keeps_its_pixels_on_an_unsigned_cape(fppd):
    """A port whose config has no differentialType at all (a cape without
    smart receivers saves none) is a plain string: on a cape without a
    signature, where every port is cut to 50 pixels, its 10 pixels still go
    out -- the frame is 30 bytes long.

    Regression: 289626aaa. With no differentialType the receiver type was
    None, which compared unequal to Standard and so marked the port a smart
    receiver; the unsigned-cape clamp sends nothing on a smart receiver
    port, and the string went dark.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    port = pixel_output(0, 10, 0)
    del port["differentialType"]
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift16", [port]))
    fppd.start(timeout=60)
    lines = [l for l in fppd.log().splitlines() if "sustainable ceiling" in l]
    assert lines and "longest string 30 bytes" in lines[0], lines or fppd.tail()


def test_a_cape_data_pin_the_firmware_cannot_drive_is_refused(fppd):
    """A cape whose pruPinConfig names PRU1's data pins by header pin:
    P2-02 is r30 bit 0, which the firmware drives; P1-29 is bit 17, outside
    the r30.b0 byte it shifts out. The port on P1-29 is refused with a
    warning naming the pin; the one on P2-02 starts.

    Feature: 000c18546 (the string half). Capes could not name their data
    pins: the pin index was the r30 bit, whatever pin the cape had wired.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="info")
    write_string_cape("TestNamedPins", {
        "driver": "BBShiftString",
        "pruPinConfig": [{"pru": 1, "dataPins": ["P2-02", "P1-29"]}],
        "outputs": [{"pru": 1, "pin": 0, "index": 0}, {"pru": 1, "pin": 1, "index": 0}]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestNamedPins", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)]))
    fppd.start(timeout=60)
    w = warnings_of(fppd)
    assert "BBShiftString: unusable data pin P1-29" in w, w
    assert not any("P2-02" in x for x in w), w
    assert "sustainable ceiling" in fppd.log(), fppd.tail()


def test_a_falcon_v5_port_on_a_cape_without_listeners_runs_send_only(real_pru, fppd):
    """A port set to a Falcon V5 receiver on a shift cape with no
    falconV5ListenerConfig: fppd says it falls back to send-only (V4)
    handling and the strings run on PRU1, frames flowing, with no listener
    program loaded on PRU0 -- it stays offline -- and no query frames are budgeted
    for it.

    Feature: 3fef60504. Falcon V4 (send-only) and V5 (bidirectional) were
    one protocol, and a V5 selection set the listener up on PRU0 whatever
    the cape had wired.
    """
    fppd.settings(LogLevel_ChannelOut="info")
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    ports = [pixel_output(n, 10, n * 30) for n in range(4)]
    ports[0]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift16", ports))
    fppd.start(timeout=60)
    fppd.command("Test Start", "1000", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(5)
    assert pru.core_state(1) == "running", pru.core_state(1)
    assert pru.core_state(0) == "offline", f"PRU0 is {pru.core_state(0)}"
    with pru.Pruss() as p:
        # frames, timed off the ring read pointer PRU1 publishes (older
        # firmware has no frame counter to read)
        frames = len(frame_spans(p, 2.0))
    assert frames > 25, f"PRU1 rendered {frames} frames in 2 s"
    # no query frames are scheduled for a send-only chain
    ceiling = [l for l in fppd.log().splitlines() if "sustainable ceiling" in l]
    assert ceiling and not any("queries" in l for l in ceiling), ceiling
    assert "falling back to send-only V4 handling" in fppd.log(), fppd.tail()
    fppd.command("Test Stop")


def test_set_port_status_during_reloads_never_calls_into_a_freed_receiver_handler(fppd):
    """A Falcon V5 receiver's port is toggled with "Set Port Status" over
    and over from the API while the string config is saved again and
    again, each save destroying and rebuilding the FalconV5Support that
    handles the toggles. co_slowsetoutput.so holds SetOutput() for 50 ms
    after each lock it releases -- on its way to that handler -- so every
    reload lands inside one. fppd stays up with no sanitizer report.

    Exercises 9623d3e28, but does not guard it: SetOutput() copied the
    handler out from under its lock and called the copy afterwards, so a
    reload destroying its owner in between left the call writing into
    freed memory -- yet an ASan build of the fix's parent, held and
    reloaded like this (the handler reached, checked under gdb), reported
    nothing in 12 reloads. The window this holds open is not the one the
    reload's delete lands in, or not often enough.
    """
    import threading
    fake_pru(fppd)
    outs = shift_outputs()
    outs[0]["falconV5Listener"] = 0
    listener_cape("TestV5Toggle", outs)
    ports = [pixel_output(n, 10, n * 30) for n in range(4)]
    ports[0]["differentialType"] = 10  # one Falcon V5 receiver
    cfg = strings_config("BBShiftString", "TestV5Toggle", ports)
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=90, preload=[shims.build("co_slowsetoutput.c")])
    names = [p.get("name") for p in fppd.get("/fppd/ports")]
    assert "Port 1" in names, names
    stop = threading.Event()
    errors = []

    def toggle():
        on = True
        while not stop.is_set():
            try:
                fppd.command("Set Port Status", "Port 1A", "true" if on else "false", timeout=20)
            except Exception as e:  # fppd gone: the fixture reports why
                errors.append(e)
                return
            on = not on

    threads = [threading.Thread(target=toggle) for _ in range(3)]
    for t in threads:
        t.start()
    try:
        for _ in range(12):
            save_strings(fppd, cfg)
            time.sleep(1.5)
            fppd.check_alive()
    finally:
        stop.set()
        for t in threads:
            t.join(timeout=30)
    assert fppd.log().count("Calling Init() on BBShiftString output") >= 10, "the config was not reloaded"
    assert not errors, errors
    with open(os.path.join(fppd.media, "logs", "fppd.stdout")) as f:
        assert "co_slowsetoutput: holding OutputMonitor::SetOutput" in f.read(), "the shim never held SetOutput"


def test_a_ring_read_position_knocked_out_of_step_heals_on_the_next_frame(real_pru, fppd):
    """16 ports of 50 pixels running a test pattern on PRU1. The test halts
    PRU1, moves its ring read pointer (r0) on by one 64 byte block -- the
    one-block skew a lost or extra block leaves -- and lets it run again:
    on the next frame the firmware re-seats onto the frame start the pump
    published (its resync counter goes to 1), and it goes on rendering at
    full rate with no pump-side resynchronization.

    Feature: c6d86600e. The firmware read on from wherever it had stopped,
    so a skew like this lasted for the life of the output: every frame
    rendered a block (a byte per string) out.
    """
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    cfg = strings_config("BBShiftString", "TestShift16", [pixel_output(n, 50, n * 150) for n in range(16)])
    fppd.write("config/co-bbbStrings.json", cfg)
    fppd.start(timeout=60)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(6)
    with pru.Pruss() as p:
        assert p.dram(1, pru.RING_RESYNC) == 0
        base, size = p.dram(1, pru.RING_CONFIG), p.dram(1, pru.RING_CONFIG + 4)
        assert p.halt(1), "PRU1 did not halt"
        r0 = p.register(1, 0)
        moved = base + (r0 - base + 64) % size
        p.set_register(1, 0, moved)
        moved_to = p.register(1, 0)
        assert p.resume(1), "PRU1 did not stay running"
        assert base <= r0 < base + size, f"r0 {r0:#x} is not in the ring {base:#x}+{size}"
        assert moved_to == moved, f"r0 read back {moved_to:#x}, not {moved:#x}"
        time.sleep(2)
        frames = p.dram(1, pru.RING_FRAMES)
        time.sleep(3)
        frames = p.dram(1, pru.RING_FRAMES) - frames
        resyncs = p.dram(1, pru.RING_RESYNC)
    fppd.command("Test Stop")
    assert resyncs == 1, f"{resyncs} re-seats after a one-block skew"
    assert frames > 40, f"{frames} frames in 3 s after the skew"
    assert "resynchronizing the ring" not in fppd.log(), fppd.tail()


def frame_spans(p, seconds=1.0):
    """How long PRU1 takes over each frame, in seconds: the time from the
    first to the last move of the ring read pointer it publishes, for each
    burst of moves (a frame), sampled as fast as Python reads it."""
    base, size = p.dram(1, pru.RING_CONFIG), p.dram(1, pru.RING_CONFIG + 4)
    consumed = base - pru.SHARED_PRU_ADDR + size + 4  # ring base + size + 4, the PRU's read position
    spans, first, last, prev = [], None, None, p.shared(consumed)
    deadline = time.monotonic() + seconds
    while (now := time.monotonic()) < deadline:
        v = p.shared(consumed)
        if v != prev:
            prev = v
            if last is not None and now - last > 0.004:
                spans.append(last - first)
                first = None
            if first is None:
                first = now
            last = now
    return spans


@pytest.mark.parametrize("protocol,cell_ns", [("ws2811", 1120), ("ucs1903", 2500)])
def test_a_port_is_clocked_at_its_protocols_bit_cell(real_pru, fppd, protocol, cell_ns):
    """Every port at 50 pixels of one protocol: PRU1 takes as long over a
    frame as 1200 bits of that protocol's cell -- 1.12 us for ws2811,
    2.5 us for the 400 kHz ucs1903 -- measured from the ring read pointer
    it publishes as it renders (within 15%; the last block's time is not
    seen).

    Feature: 4e43e80f3. The bit cell was compiled into the firmware: every
    part got the ws281x cell, which puts a 400 kHz part's pulses outside
    the window it decodes.
    """
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": shift_outputs()})
    ports = [pixel_output(n, 50, n * 150) for n in range(16)]
    for port in ports:
        port["protocol"] = protocol
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift16", ports))
    fppd.start(timeout=60)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(5)
    with pru.Pruss() as p:
        spans = sorted(frame_spans(p, 2.0))
    fppd.command("Test Stop")
    assert len(spans) > 20, spans
    span = spans[len(spans) // 2]
    want = 1200 * cell_ns * 1e-9
    assert abs(span - want) < 0.15 * want, f"{protocol}: a frame took {span * 1e3:.2f} ms, not {want * 1e3:.2f}"


def test_a_cape_with_16_strings_per_data_pin_runs_the_16_deep_firmware(real_pru, fppd):
    """A cape declaring "stringsPerPin": 16 (a 16 deep shift register chain
    on each of PRU1's data pins, 128 strings), with strings on the first
    and the last of a chain: PRU1 runs the SHIFT16 firmware and renders
    frames through a test pattern, with no warning.

    Feature: 414493406. Every cape was driven as 8 strings a pin.
    """
    outs = [{"pru": 1, "pin": p, "index": i} for p in range(8) for i in range(16)]
    write_string_cape("TestShift128", {"driver": "BBShiftString", "stringsPerPin": 16, "outputs": outs})
    ports = [pixel_output(n, 20, i * 60) for i, n in enumerate((0, 15, 16, 127))]
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "TestShift128", ports))
    fppd.start(timeout=60)
    fppd.command("Test Start", "100", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    time.sleep(5)
    with open("/lib/firmware/am62x-pru1-fw.fpp", "rb") as f:
        running = f.read()
    with open("/opt/fpp/src/non-gpl/BBShiftString/BBShiftString_pru1_16.out", "rb") as f:
        assert running == f.read(), "PRU1 is not running the SHIFT16 firmware"
    with pru.Pruss() as p:
        frames = p.dram(1, pru.RING_FRAMES)
        time.sleep(2)
        frames = p.dram(1, pru.RING_FRAMES) - frames
    fppd.command("Test Stop")
    assert frames > 25, f"{frames} frames in 2 s"
    assert not any("BBShiftString" in w for w in warnings_of(fppd)), warnings_of(fppd)
