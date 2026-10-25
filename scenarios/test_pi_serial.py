"""Channel outputs on a Raspberry Pi's own UART, /dev/ttyAMA0.

Device only: run with run-local.sh on a Pi where ttyAMA0 is not the
console and nothing else has it open. The UART need not reach the header
(an overlay may leave its pins as GPIOs): the port's line settings are
read back with termios, and the bytes sent with the kernel's own transmit
count for the port (/proc/tty/driver/ttyAMA), so nothing has to be wired.
run-local.sh's pinctrl stub logs the pin muxing fppd asks for and does
none of it.
"""

import os
import re
import subprocess
import termios

import pytest

import hosttools

DEVICE = "/dev/ttyAMA0"


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


def usable():
    """Why ttyAMA0 can't be used here, or None."""
    if not on_pi():
        return "not a Raspberry Pi"
    if not os.path.exists(DEVICE):
        return "no /dev/ttyAMA0"
    try:
        with open("/proc/cmdline") as f:
            if re.search(r"console=(serial0|ttyAMA0)\b", f.read()):
                return "ttyAMA0 is the console"
    except OSError:
        pass
    r = subprocess.run(["fuser", DEVICE], capture_output=True, text=True)
    if r.stdout.strip():
        return f"ttyAMA0 is open in process {r.stdout.strip()}"
    return None


@pytest.fixture
def uart():
    why = usable()
    if why:
        pytest.skip(why)
    return DEVICE


def line_settings():
    """termios of the port, as the driver holds it now. The open is
    O_NONBLOCK and asks for nothing, so it changes nothing (root may open
    a port fppd holds with TIOCEXCL)."""
    fd = os.open(DEVICE, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        return termios.tcgetattr(fd)
    finally:
        os.close(fd)


def tx_count():
    """Bytes the PL011 has transmitted since boot (the kernel's count)."""
    with open("/proc/tty/driver/ttyAMA") as f:
        for line in f:
            if line.startswith("0:"):
                return int(re.search(r"\btx:(\d+)", line).group(1))
    pytest.skip("no count for ttyAMA0 in /proc/tty/driver/ttyAMA")


def renard(parm):
    return {"channelOutputs": [{
        "type": "Renard", "enabled": 1, "startChannel": 1, "channelCount": 24,
        "device": "ttyAMA0", "renardspeed": 57600, "renardparm": parm}]}


def test_a_seven_bit_even_parity_port_runs_as_configured(uart, fppd):
    """A Renard output on ttyAMA0 with renardparm 7E1 leaves the UART at 7
    data bits with even parity, as the driver reports it while fppd holds
    the port.

    Regression: a66327bfc. SerialOpen() set the character size and parity
    from the mode string and then called cfmakeraw(), which puts the size
    back to 8 bits and clears parity: a 7E1 port silently ran 8N1.
    """
    fppd.write("config/co-other.json", renard("7E1"))
    fppd.start()
    fppd.command("Test Start", "100", "RGB Single Color", "1-24", "#FFFFFF")
    fppd.wait_for(lambda: subprocess.run(["fuser", DEVICE], capture_output=True, text=True).stdout.strip(),
                  what="fppd to open ttyAMA0")
    cflag = line_settings()[2]
    got = {"bits": {termios.CS5: 5, termios.CS6: 6, termios.CS7: 7, termios.CS8: 8}[cflag & termios.CSIZE],
           "parity": ("odd" if cflag & termios.PARODD else "even") if cflag & termios.PARENB else "none"}
    assert got == {"bits": 7, "parity": "even"}, f"7E1 asked for, the port runs {got}"


def test_dmx_on_the_pi_uart_claims_its_pin_and_sends(uart, fppd):
    """A DMX-Open output on ttyAMA0 starts: it puts the UART's transmit pin
    (GPIO14, P1-8) on its UART function (a0, a4 on a Pi 5) through pinctrl,
    runs the port 8N2, and the UART transmits frames.

    Regression: 1f603c7a8. The Pi pin table had no UART pins, so
    SerialChannelOutput's lookup of "ttyAMA0-tx" found none and it took
    the name of the null pin it got: fppd died loading the output. The
    pin wasn't muxed to the UART either.
    """
    pi5 = "Raspberry Pi 5" in open("/proc/device-tree/model").read()
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "DMX-Open", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "device": "ttyAMA0"}]})
    calls = hosttools.pinctrl_calls()
    before = tx_count()
    fppd.start()
    fppd.command("Test Start", "100", "RGB Single Color", "1-512", "#FFFFFF")
    fppd.wait_for(lambda: tx_count() - before > 5 * 513, timeout=10,
                  what="five DMX frames out of the UART")
    fppd.check_alive()
    assert f"set 14 {'a4' if pi5 else 'a0'}" in calls.calls(), calls.calls()
    cflag = line_settings()[2]
    assert cflag & termios.CSIZE == termios.CS8 and cflag & termios.CSTOPB \
        and not cflag & termios.PARENB, f"cflag {cflag:o}: not 8N2"
