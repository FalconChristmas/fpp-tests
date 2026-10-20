"""Serial channel outputs, written into a pty and decoded."""

import os
import termios
import time

import pytest

import shims
from serial import PtyReader, lor_enhanced_state


def range_on(fppd, channels, value):
    """Light channels 1..channels with an overlay range, so outputs send."""
    fppd.request("PUT", f"/overlays/range/1-{channels}", {"Value": value})


def test_lor_enhanced_reaches_every_unit(fppd):
    """Every configured LOR Enhanced unit receives its pixels, including one
    placed part way along its controller.

    Regression: 41fc40f38. The per-unit range check counted the LOR start
    pixel as FPP channels, so a unit starting past pixel 1 of its controller
    near the end of the output was rejected as exceeding the channel count
    and never sent. Here the third unit shares LOR unit 1 from pixel 51.
    """
    units = [  # LOR unit id, pixels, LOR start pixel, start channel in the output
        (1, 50, 1, 1),
        (2, 40, 11, 151),
        (1, 30, 51, 271),
    ]
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOREnhanced", "enabled": 1, "startChannel": 1, "channelCount": 360,
            "device": pty.device, "speed": 500000,
            "units": [{"unitId": u, "numOfPixels": px, "lorStartPixel": start, "fppStartAddr": ch}
                      for u, px, start, ch in units],
        }]})
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-360", "R-G-B")

        def missing():
            state = lor_enhanced_state(pty.messages())
            gaps = []
            for u, px, start, _ in units:
                got = state.get(u, {})
                first = (start - 1) * 3
                lacking = sum(1 for c in range(first, first + px * 3) if c not in got)
                if lacking:
                    gaps.append(f"unit {u} from pixel {start}: {lacking} of {px * 3} channels never sent")
            return gaps

        deadline = time.monotonic() + 10
        while missing() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert not missing(), "; ".join(missing())


def test_lor_enhanced_without_a_speed_runs_at_1mbps(fppd):
    """A LOR Enhanced output whose config names no speed opens its port at
    1 Mbps, the rate Pixies run their LOR network at.

    Regression: ddc172b48. The default was 500k, so such an output talked to
    its Pixies at half the rate they listen on.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOREnhanced", "enabled": 1, "startChannel": 1, "channelCount": 150,
            "device": pty.device,
            "units": [{"unitId": 1, "numOfPixels": 50, "lorStartPixel": 1, "fppStartAddr": 1}],
        }]})
        fppd.start()
        # Data on the pty shows the output opened and configured its port.
        fppd.command("Test Start", "100", "RGB Cycle", "1-150", "R-G-B")
        fppd.wait_for(lambda: pty.messages(), what="LOR data on the pty")
        ospeed = termios.tcgetattr(pty.slave)[5]
        # SerialOpen() sets a rate termios has no constant for through termios2,
        # which reads back here as BOTHER.
        names = {termios.B500000: "B500000", termios.B1000000: "B1000000", 0o010000: "a custom rate (BOTHER)"}
        assert ospeed == termios.B1000000, f"port opened at {names.get(ospeed, ospeed)}, not B1000000"


def test_serial_device_without_a_pin_raises_no_warning(fppd):
    """A serial output on a device with no header pin (a pty here; in use, a
    USB adapter named by its /dev/serial/by-id path) starts without a
    warning banner.

    Regression: efa23cbf5. SerialOpen() configured the UART pin of anything
    not named /dev/ttyUSB*, and configuring the empty placeholder pin raised
    "Could not configure pin -none-", which stayed up until fppd restarted.

    Hardware-only: the warning comes from a GPIO line request failing, which
    needs a device's pin provider. In Docker this passes with or without the
    fix; it was verified with run-local.sh on a PocketBeagle2, failing on the
    fix's parent and passing with the fix.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOR", "enabled": 1, "startChannel": 1, "channelCount": 16,
            "device": pty.device, "speed": 19200, "firstControllerId": 1,
        }]})
        fppd.start()
        # Data on the pty shows the output opened its port.
        fppd.command("Test Start", "100", "RGB Cycle", "1-16", "R-G-B")
        fppd.wait_for(lambda: pty.messages(), what="LOR data on the pty")
        warnings = fppd.get("/fppd/warnings")
        pin = [w for w in warnings if "configure pin" in str(w)]
        assert not pin, f"warning banner for a device with no pin: {pin}"


def _serial_console():
    """The active kernel console if it is a serial tty with a /dev node, else None."""
    try:
        with open("/sys/class/tty/console/active") as f:
            names = f.read().split()
    except OSError:
        return None
    for name in names:
        if name.startswith("tty") and not name[3:].isdigit() and os.path.exists("/dev/" + name):
            return name
    return None


@pytest.mark.skipif(_serial_console() is None, reason="the kernel console is not a serial tty here")
def test_serial_output_refuses_the_console(fppd):
    """A serial output configured on the kernel console's tty is refused,
    with a warning, instead of mixing channel data into the console.

    Regression: 854a9dd8d. On a PocketBeagle 2 the console is ttyS2, the
    name PocketBeagle capes used for DMX, so a carried-over DMX output opened
    the console and muxed a header pin onto its transmit line.

    Hardware-only: needs a board whose console is a serial UART (the
    PocketBeagle 2's is). Docker and the Pis skip it. Verified with
    run-local.sh on a PocketBeagle 2, failing on the fix's parent and passing
    with the fix.
    """
    console = _serial_console()
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "DMX-Open", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "device": console,
    }]})
    fppd.start()
    fppd.wait_for(lambda: [w for w in fppd.get("/fppd/warnings") if "system console" in str(w)],
                  what=f"a warning that /dev/{console} is the system console")


def test_reloading_a_slow_serial_output_with_a_frame_pending(fppd):
    """Saving the Other outputs while a threaded serial output's worker is
    still busy with a frame, with the next frame already queued, replaces
    the output cleanly: fppd lives and the new output sends.

    co_slowwrite.so makes every write() to the pty take 120 ms, so at 20
    frames a second the worker always has the next frame waiting when the
    reload closes the output.

    Regression: 33017c3ea. GenericSerialOutput::Close() closed the port and
    deleted its packet buffer before ThreadedChannelOutput::Close() stopped
    the worker, and the worker flushed the pending frame on its way out:
    memcpy() into the freed, nulled buffer, a SIGSEGV on the first reload.
    """
    def config(description):
        return {"channelOutputs": [{
            "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 100,
            "description": description, "device": pty.device, "speed": 115200,
            "header": "HDR", "footer": ""}]}

    with PtyReader() as pty:
        fppd.write("config/co-other.json", config("a"))
        fppd.start(preload=[shims.build("co_slowwrite.c")], extra_env={
            "CO_SLOWWRITE_DEVICE": "/dev/" + pty.device, "CO_SLOWWRITE_MS": "120"})
        range_on(fppd, 100, 0x40)

        def frames_since(mark):
            with pty.lock:
                return pty.data.count(b"HDR" + bytes([0x40]) * 100, mark)

        fppd.wait_for(lambda: frames_since(0) >= 2, what="GenericSerial frames on the pty")
        for i in range(5):
            time.sleep(1.1)  # a save in a later second, as a person makes it
            with pty.lock:
                mark = len(pty.data)
            fppd.write("config/co-other.json", config(f"save {i}"))
            fppd.wait_for(lambda: frames_since(mark) >= 4, timeout=10,
                          what=f"frames after save {i + 1}")


@pytest.mark.parametrize("pixels", [171, 170])
def test_lor_enhanced_unit_with_a_blank_start_pixel(fppd, pixels):
    """A LOR Enhanced unit whose LOR Start Pixel was left blank (saved as
    null) counts from pixel 1: at 171 pixels it is refused as more than 510
    channels, with a warning, and at 170 (the control) it is sent.

    Regression: c09c7aa03. A blank start pixel read as 0, so the 510-channel
    check worked out (0 - 1) * 3 + 513 = 510 and let 171 pixels through;
    the first frame then wrote 3 bytes past the unit's 518-byte packet
    buffer, a heap-buffer-overflow.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "LOREnhanced", "enabled": 1, "startChannel": 1, "channelCount": 513,
            "device": pty.device, "speed": 1000000,
            "units": [{"unitId": 1, "numOfPixels": pixels, "lorStartPixel": None,
                       "fppStartAddr": 1}],
        }]})
        fppd.start()
        fppd.command("Test Start", "100", "RGB Cycle", "1-513", "R-G-B")

        def refused():
            return [w for w in fppd.get("/fppd/warnings")
                    if "more than 510 channels" in str(w)]

        if pixels > 170:
            fppd.wait_for(refused, what="the more-than-510-channels warning")
            time.sleep(2)
            assert 1 not in lor_enhanced_state(pty.messages()), "the refused unit was sent"
        else:
            fppd.wait_for(lambda: lor_enhanced_state(pty.messages()).get(1), what="unit 1's pixels")
            assert not refused(), "170 pixels from pixel 1 were refused"


def test_usb_pixelnet_with_more_than_one_universe(fppd):
    """A USB Pixelnet output configured (by hand or through the API) for more
    channels than one Pixelnet universe holds sends 4096-channel packets and
    fppd lives.

    Regression: 717c39717. RawSendData() copied all 6000 channels into the
    4104-byte packet buffer, over the members after it and past the end of
    the object: a heap-buffer-overflow on the first frame.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", {"channelOutputs": [{
            "type": "Pixelnet-Open", "enabled": 1, "startChannel": 1, "channelCount": 6000,
            "device": pty.device}]})
        fppd.start()
        range_on(fppd, 6000, 0x40)
        header = bytes([0xAA, 0x55, 0x55, 0xAA, 0x15, 0x5D])

        def packets():
            with pty.lock:
                data = bytes(pty.data)
            return [p for p in data.split(header)[1:-1]]

        fppd.wait_for(lambda: any(p == bytes([0x40]) * 4096 for p in packets()),
                      what="a full 4096-channel Pixelnet packet")
        time.sleep(2)
        bad = [len(p) for p in packets() if len(p) != 4096]
        assert not bad, f"packets that are not 4096 channels: {bad[:10]}"


def set_range(fppd, first, last, value):
    """Hold channels first..last (1-based) at value with an overlay range."""
    fppd.request("PUT", f"/overlays/range/{first}-{last}", {"Value": value})


def lor_output(pty, channels, first_unit=1):
    return {"channelOutputs": [{
        "type": "LOR", "enabled": 1, "startChannel": 1, "channelCount": channels,
        "device": pty.device, "speed": 19200, "firstControllerId": first_unit}]}


def lor_commands(pty):
    """The LOR intensity commands sent so far, as (unit, level, circuit)."""
    return [(m[0], m[2], m[3] & 0x0F) for m in pty.messages()
            if len(m) == 4 and m[1] == 0x03 and m[3] & 0x80]


def lor_heartbeats(pty):
    return sum(1 for m in pty.messages() if m == b"\xff\x81\x56")


def test_lor_sends_channels_that_start_off(fppd):
    """The first frames send every LOR channel, including those that are
    off: each of 32 channels held at 0 gets the "off" level (0xF0), on both
    units.

    Regression: 817463732. The last-sent table started at 0 and only
    changes were sent, so a channel that should be off was never sent, and
    a unit left on (by an earlier run, or by xLights) stayed on.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor_output(pty, 32))
        fppd.start()
        set_range(fppd, 33, 33, 0)  # keeps the output thread sending; LOR's channels stay 0

        def off():
            return {(u, c) for u, level, c in lor_commands(pty) if level == 0xF0}

        want = {(u, c) for u in (1, 2) for c in range(16)}
        deadline = time.monotonic() + 5
        while not want <= off() and time.monotonic() < deadline:
            time.sleep(0.2)
        assert want <= off(), f"channels never sent as off: {sorted(want - off())}"


def test_lor_heartbeat_runs_while_idle(fppd):
    """With nothing playing, the LOR output still sends its heartbeat (about
    every 300 ms), so units stay connected between sequences.

    Regression: 817463732. The heartbeat was only sent from SendData(),
    which stops a few seconds after output goes idle; units dropped to "not
    connected" and missed the first commands of the next sequence.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor_output(pty, 16))
        fppd.start()
        time.sleep(6)  # well past the output thread winding down
        before = lor_heartbeats(pty)
        time.sleep(2)
        sent = lor_heartbeats(pty) - before
    assert sent >= 4, f"{sent} heartbeats in 2 s of idle"


def test_lor_keeps_to_the_line_rate(fppd):
    """512 LOR channels that all change every frame are sent no faster than
    a 19200 baud line carries them (1920 bytes a second), instead of
    building a backlog behind the music.

    Regression: 817463732. Every changed channel was written every frame,
    six bytes each: about 30 KB a second here, sixteen times the line.
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor_output(pty, 512))
        fppd.start()
        fppd.command("Test Start", "50", "RGB Cycle", "1-512", "R-G-B")
        time.sleep(2)
        with pty.lock:
            start = len(pty.data)
        t0 = time.monotonic()
        time.sleep(3)
        with pty.lock:
            sent = len(pty.data) - start
        rate = sent / (time.monotonic() - t0)
    assert lor_commands(pty), "no LOR commands at all"
    assert rate <= 1.3 * 1920, f"{rate:.0f} bytes/s on a 1920 bytes/s line"


def test_lor_channels_past_unit_f0_are_dropped(fppd):
    """Channels that would need a LOR unit ID above 0xF0 (the last one a
    unit can have) are not sent; they don't overwrite unit 0xF0's circuits.
    Unit 240 has channels 1-16 at 0, and channels 17-32 at full would be
    unit 241.

    Regression: 817463732. Unit IDs were capped at 0xF0, so channels 17-32
    went to unit 0xF0 as well, and its circuits showed them (level 0x01).
    """
    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor_output(pty, 32, first_unit=240))
        fppd.start()
        set_range(fppd, 17, 32, 255)
        fppd.wait_for(lambda: [c for c in lor_commands(pty) if c[0] == 0xF0],
                      what="commands for unit 0xF0")
        time.sleep(2)
        cmds = lor_commands(pty)
    full = sorted({c for u, level, c in cmds if u == 0xF0 and level == 0x01})
    assert not full, f"unit 0xF0 circuits set to full by channels past it: {full}"
    beyond = sorted({u for u, _, _ in cmds if u > 0xF0})
    assert not beyond, f"commands for unit IDs past 0xF0: {beyond}"


def test_lor_intensity_is_a_whole_percent(fppd):
    """LOR intensity goes out as a whole percent, 228 - 2 * percent, with
    0xF0 for off and 0x01 for full: channel values 1, 64, 128 and 254 are
    levels 0xF0, 0xB2, 0x80 and 0x01.

    Regression: 891455ae7 (the table 817463732 had replaced with a linear
    map over 0xF0..0x01, which put 64 at 0xB4 and 128 at 0x78).
    """
    values = [1, 64, 128, 254]
    want = [0xF0, 0xB2, 0x80, 0x01]
    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor_output(pty, 16))
        fppd.start()
        for ch, v in enumerate(values, 1):
            set_range(fppd, ch, ch, v)

        def latest():
            last = {}
            for u, level, c in lor_commands(pty):
                if u == 1:
                    last[c] = level
            return [last.get(c) for c in range(len(values))]

        deadline = time.monotonic() + 5
        while latest() != want and time.monotonic() < deadline:
            time.sleep(0.2)
        got = latest()
    assert got == want, f"levels {[hex(v) if v is not None else None for v in got]}"


def test_serial_open_warning_comes_down_when_the_port_is_fixed(fppd):
    """A LOR output on a port that doesn't exist raises "could not open";
    once co-other.json names a port that does, the output sends and the
    warning comes down.

    Regression: 176d2d251. The serial Init() warnings (setupSerialPort()'s
    "could not open" and SerialOpen()'s id 38) were raised with plain
    AddWarning() and never retracted, so both stayed up until fppd
    restarted although the output worked.
    """
    def lor(device):
        return {"channelOutputs": [{
            "type": "LOR", "enabled": 1, "startChannel": 1, "channelCount": 16,
            "device": device, "speed": 19200, "firstControllerId": 1}]}

    def stale():
        return [w for w in fppd.get("/fppd/status").get("warnings", []) if "pts/999" in w]

    with PtyReader() as pty:
        fppd.write("config/co-other.json", lor("pts/999"))
        fppd.start()
        fppd.wait_for(stale, timeout=10, what="the could-not-open warning")
        time.sleep(1.1)
        fppd.write("config/co-other.json", lor(pty.device))
        set_range(fppd, 1, 16, 0x80)
        fppd.wait_for(lambda: pty.messages(), timeout=10, what="LOR data on the real port")
        fppd.wait_for(lambda: not stale(), timeout=5, interval=0.5,
                      what=f"the warnings for the missing port to come down (still: {stale()})")
