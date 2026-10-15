"""Serial channel outputs, written into a pty and decoded."""

import os
import time

import pytest

from serial import PtyReader, lor_enhanced_state


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
