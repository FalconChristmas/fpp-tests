"""Serial outputs sent from a PRU on an AM62x board (util/BBBPruSerial.cpp,
pru/PRUSerial.asm), for a cape whose line driver hangs off a header pin
with no UART transmit on a PocketBeagle 2.

Device only: run with run-local.sh --host-pru on a PocketBeagle 2 with the
device's own fppd stopped. The scenario stands in its own cape for the
device's (an unsigned EEPROM image in run-local.sh's /home/fpp/media
overlay, put back after) and reads what PRU0 drives on the pin from the
GPIO controller's output register; run-local.sh's stub pinctrl leaves the
pad as it is. Skipped elsewhere.
"""

import ctypes
import mmap
import os
import shutil
import time

import pytest

import cape_eeprom as ee
from pru import real_pru  # noqa: F401 (a fixture)

VIRTUAL_EEPROM = "/home/fpp/media/config/cape-eeprom.bin"

# P1-10: line 7 of the 601000.gpio controller on a PocketBeagle 2
P1_10 = (0x601000, 7)


@pytest.fixture
def labelled_cape():
    """A cape whose cape-info labels ttyS2 as wired to P1-10, as a
    PocketBeagle cape with its DMX/Renard driver on P1-10 (UART2 TX on a
    PocketBeagle) does."""
    if not os.path.isdir(os.path.dirname(VIRTUAL_EEPROM)):
        pytest.skip("no /home/fpp/media here")
    saved = VIRTUAL_EEPROM + ".fpp-tests"
    had = os.path.exists(VIRTUAL_EEPROM)
    if had:
        shutil.copyfile(VIRTUAL_EEPROM, saved)
    with open(VIRTUAL_EEPROM, "wb") as f:
        f.write(ee.image(ee.cape_info(**{"tty-labels": {"ttyS2": "P1-10"}})))
    try:
        yield
    finally:
        if had:
            os.replace(saved, VIRTUAL_EEPROM)
        else:
            os.remove(VIRTUAL_EEPROM)


class Line:
    """Samples one GPIO output line's driven level as fast as Python can."""

    def __init__(self, base, bit):
        # writable only because ctypes maps its arrays over writable buffers;
        # nothing is written
        fd = os.open("/dev/mem", os.O_RDWR | os.O_SYNC)
        try:
            self.mm = mmap.mmap(fd, 4096, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=base)
        finally:
            os.close(fd)
        self.bit = bit

    def edges(self, seconds):
        """[(time, level)] at each change of level, from a first sample."""
        reg = (ctypes.c_uint32 * 1024).from_buffer(self.mm)
        out = []
        prev = None
        clock = time.perf_counter
        end = clock() + seconds
        while (t := clock()) < end:
            v = (reg[5] >> self.bit) & 1  # OUT_DATA at 0x14
            if v != prev:
                out.append((t, v))
                prev = v
        return out


def uart_bytes(edges, baud):
    """Decode 8N1 UART bytes from a line's edges (idle high)."""
    bit = 1.0 / baud
    level_at = lambda t: next((v for tt, v in reversed(edges) if tt <= t), 1)  # noqa: E731
    out = []
    i = 0
    while i < len(edges):
        t, v = edges[i]
        if v == 0 and (i == 0 or edges[i - 1][1] == 1):
            value = 0
            for n in range(8):
                value |= level_at(t + (1.5 + n) * bit) << n
            if level_at(t + 9.5 * bit) == 1:
                out.append(value)
            end = t + 9.9 * bit
            while i < len(edges) and edges[i][0] < end:
                i += 1
            continue
        i += 1
    return bytes(out)


def test_a_serial_output_on_a_pin_with_no_uart_transmit_is_sent_from_a_pru(real_pru, labelled_cape, fppd):
    """A GenericSerial output at 9600 baud on ttyS2, which the cape labels
    as its line driver's pin P1-10 -- on a PocketBeagle 2 a pin with only
    UART receive functions: fppd sends it from PRU0, and the line carries
    the frames, header and channel data, as 8N1 bytes.

    Feature: a896ff396. Since 854a9dd8d such an output was refused, and
    before that its data went out of a UART whose pin nothing had muxed.
    """
    fppd.settings(LogLevel_ChannelOut="info")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 4,
        "device": "ttyS2", "speed": 9600, "header": "FPP", "footer": ""}]})
    fppd.start(timeout=60)
    assert "sending on P1-10 from PRU0 at 9600 baud" in fppd.log(), fppd.tail()
    fppd.request("PUT", "/overlays/range/1-4", {"Value": 0x41})
    time.sleep(2)
    try:
        line = Line(*P1_10)
    except OSError as e:
        pytest.skip(f"cannot map the GPIO controller: {e}")
    data = uart_bytes(line.edges(1.5), 9600)
    assert b"FPPAAAA" in data, data
