"""SPI channel outputs on a fake spidev (fakespi.c): every transfer an output
hands the kernel, with its length, whether it asks to receive, and the bytes
it sends.

GenericSPI is built everywhere, so its scenario runs in Docker too; the
MAX7219 matrix and the WS2801/Pi36 outputs are built for the Raspberry Pi
only, so theirs run under run-local.sh on a Pi (where the fake stands in
for /dev/spidev0.N, which run-local.sh hides anyway). The MAX7219 drives
its chip-select on GPIO8 (P1-24), a real line; the pads are put back after.
"""

import os
import time

import pytest

import shims
from fseq import solid_frames
from show import ddp_output, install


@pytest.fixture
def cs_pad():
    """GPIO8, the MAX7219's chip-select, its pad and line put back as they
    were after fppd stops (test_pi_gpio_inputs.lines_kept: the output fppd
    drives would otherwise stay listed as one). Ask for it before `fppd`."""
    from test_pi_gpio_inputs import lines_kept
    with lines_kept([8]):
        yield


class Spi:
    def __init__(self, fppd, miso=0x00):
        self.out = os.path.join(fppd.media, "logs", "spi.txt")
        self.env = {"FAKESPI_OUT": self.out, "FAKESPI_MISO": hex(miso)}

    def start(self, fppd, **kw):
        return fppd.start(preload=[shims.build("fakespi.c")], extra_env=self.env, **kw)

    def transfers(self):
        """[(device, length, rx, data)], oldest first; rx is "none" for a
        send-only transfer, "tx" when it receives into what it sends."""
        try:
            with open(self.out) as f:
                rows = [l.split() for l in f if l.endswith("\n")]
        except FileNotFoundError:
            return []
        rows = [(r[1], int(r[2]), r[3], bytes.fromhex(r[4]) if len(r) > 4 else b"") for r in rows]
        # On a Pi fppd probes SPI0 for an MCP23S17 GPIO expander at startup:
        # 3-byte register reads and writes, opcode 0x40/0x41. Not the output's.
        return [t for t in rows if not (t[1] == 3 and t[3][:1] in (b"\x40", b"\x41"))]


def output(fppd, o):
    fppd.write("config/co-other.json", {"channelOutputs": [dict({"enabled": 1}, **o)]})


def sequence(fppd, frames, ddp=0):
    """show.install()'s sequence and playlist, with its DDP output cut to
    the first `ddp` channels (none for 0): a sequence read then fills only
    the outputs' ranges, the SPI output's among them."""
    install(fppd, frames)
    fppd.write("config/co-universes.json", ddp_output(ddp) if ddp else {"channelOutputs": []})


def built(fppd, lib):
    if not os.path.exists(os.path.join(os.environ["FPP_TREE"], "src", f"libfpp-co-{lib}.so")):
        pytest.skip(f"no {lib} output in this build (Raspberry Pi only)")


def test_generic_spi_sends_without_receiving_into_the_channel_data(fppd):
    """A GenericSPI output's transfers are send-only (no receive buffer) and
    carry the channel data: with MISO reading 0x5A, the channels it sends go
    out as the channel tester set them, frame after frame.

    Regression: 45172734d. SPIUtils::xfer() received into the transmit
    buffer when given none, so spidev ran full duplex and wrote what came in
    on MISO over the buffer -- for GenericSPI and SPIws2801 the live
    sequence buffer the output thread was filling.
    """
    spi = Spi(fppd, miso=0x5A)
    output(fppd, {"type": "GenericSPI", "startChannel": 1, "channelCount": 30,
                  "device": "spidev0.0", "speed": "1000"})
    spi.start(fppd)
    fppd.command("Test Start", "50", "RGB Single Color", "1-30", "#102030")
    want = bytes([0x10, 0x20, 0x30] * 10)
    fppd.wait_for(lambda: sum(1 for t in spi.transfers() if t[3] == want) >= 10, timeout=10,
                  what="ten frames of the test color")
    fppd.command("Test Stop")
    rx = sorted({t[2] for t in spi.transfers()})
    assert rx == ["none"], f"transfers asked to receive: {rx}"


def test_a_max7219_past_channel_1_shows_its_own_channels(cs_pad, fppd):
    """A one-panel MAX7219 matrix starting at channel 101, with a sequence
    lighting every channel, sends rows 1-8 with all eight pixels on, and
    fppd lives.

    Regression: e39f86d5c. GetRequiredChannelRanges() reported (start,
    count - 1) for (start, start + count - 1): starting past its channel
    count, the output declared a range ending before it began. Since a later
    guard drops an inverted range ("Ignoring invalid channel range"), the
    matrix's channels were then never read from the sequence -- a DDP
    output on channels 1-10 gives the read a range, so it doesn't fall back
    to reading every channel.
    """
    built(fppd, "MAX7219Matrix")
    spi = Spi(fppd)
    sequence(fppd, solid_frames(200, 200, 255), ddp=10)
    output(fppd, {"type": "MAX7219Matrix", "startChannel": 101, "channelCount": 64,
                  "panels": 1, "channelsPerPixel": 1})
    spi.start(fppd)
    fppd.command("Start Playlist", "Show", "true", "false")
    rows = bytes(b for i in range(1, 9) for b in (i, 0xFF))
    try:
        fppd.wait_for(lambda: rows in b"".join(t[3] for t in spi.transfers()), timeout=10,
                      what="a frame of all pixels on")
    except TimeoutError:
        pytest.fail(f"last transfers: {spi.transfers()[-8:]}")
    fppd.check_alive()


@pytest.mark.parametrize("panels, channels", [(200, 200 * 64), (2, 64)])
def test_a_max7219_config_that_overruns_is_refused(cs_pad, fppd, panels, channels):
    """A MAX7219 matrix of 200 panels (each line goes out of a 256-byte
    buffer, two bytes a panel: 128 fit), or of 2 panels on 64 channels (it
    reads 64 a panel), is refused with a log line saying why: no transfer
    is ever sent, and fppd carries on.

    Regression: cbe8ab209. Init() checked neither: 200 panels wrote 400
    bytes into the 256-byte stack buffer for each command at startup and
    each line of each frame, and 2 panels read 64 channels past the output.
    """
    built(fppd, "MAX7219Matrix")
    spi = Spi(fppd)
    output(fppd, {"type": "MAX7219Matrix", "startChannel": 1, "channelCount": channels,
                  "panels": panels, "channelsPerPixel": 1})
    spi.start(fppd)
    fppd.command("Test Start", "50", "RGB Single Color", f"1-{channels}", "#FFFFFF")
    time.sleep(1)
    fppd.command("Test Stop")
    fppd.check_alive()
    assert not spi.transfers(), f"{len(spi.transfers())} transfers, the longest " \
                                f"{max(t[1] for t in spi.transfers())} bytes"
    assert "MAX7219: " in fppd.log() and ("invalid config" in fppd.log() or "need" in fppd.log())


def test_a_pi36_with_fewer_than_36_channels_gets_all_36_from_the_sequence(fppd):
    """A WS2801 output in the Pi36 layout configured for 12 channels still
    sends the 36 its two WS2803 take, and with a sequence lighting every
    channel all 36 come from the sequence: the transfer is 36 bytes of 255.

    Regression: 6836378b3. The Pi36 layout read 36 channels but reported
    only the configured 12 as its range, so a sequence read never filled
    the other 24 (and near the top of the channel space it read past what
    the loader checked). The fix's leaks -- the Pi36 buffer on each reload,
    an undetected nRF24 radio -- aren't reached here (no LeakSanitizer on
    a Pi).
    """
    built(fppd, "SPIws2801")
    spi = Spi(fppd)
    sequence(fppd, solid_frames(200, 150, 255))
    output(fppd, {"type": "SPIws2801", "startChannel": 1, "channelCount": 12,
                  "device": "spidev0.0", "pi36": 1})
    spi.start(fppd)
    fppd.command("Start Playlist", "Show", "true", "false")
    try:
        fppd.wait_for(lambda: any(t[3] == b"\xff" * 36 for t in spi.transfers()), timeout=10,
                      what="a 36-byte frame from the sequence")
    except TimeoutError:
        pytest.fail(f"last transfers: {spi.transfers()[-3:]}")
