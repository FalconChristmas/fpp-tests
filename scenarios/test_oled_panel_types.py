"""fppoled's panel geometry for the display types other than the plain
128x64 SSD1306: the flipped 128x32 and the 128x128 SH1107.

fppoled draws into a framebuffer and pushes it to the panel over i2c; the
fake panel (fakessd1306.c) records every transaction, and oled.decode_stream()
replays them the way a page-addressed controller would. A real display can't
be read back over i2c, so what these pin is what fppoled sends.

Device only: run-local.sh on a Pi or Beagle (fppoled isn't built in a
container).
"""

import time

import pytest

import oled
from test_oled import oled_media, screen  # noqa: F401 -- fixtures


def wait_for_bytes(s, n, timeout=30):
    """Wait until the panel has been sent at least n data bytes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        total = sum(len(b) for k, b in s.stream() if k == "data")
        if total >= n:
            return
        if s.proc.poll() is not None:
            raise AssertionError(f"fppoled exited {s.proc.returncode}\n{s.log()}")
        time.sleep(0.2)
    raise AssertionError(f"only {total} data bytes after {timeout}s\n{s.log()}")


def test_a_flipped_128x32_panel_gets_its_image_on_the_pages_it_scans(oled_media, screen):
    """LEDDisplayType 4 (128x32 Flipped I2C): the status page's pixels land
    in GDDRAM pages 0-3, the four a 32-row panel scans out, and a refresh is
    512 bytes.

    Regression: ecf813af9. The drawing code mirrored a rotated panel about
    row 63 whatever its height, so a flipped 128x32 display drew everything
    into pages 4-7, which the panel (multiplex ratio 31) never shows: it
    stayed dark.
    """
    oled_media.settings(LEDDisplayType=4)
    screen.start()
    wait_for_bytes(screen, 2048)
    pages, _ = oled.decode_stream(screen.stream())
    lit = {p: sum(1 for x in data if x) for p, data in pages.items()}
    assert sum(lit.get(p, 0) for p in range(0, 4)) > 0, lit
    assert sum(lit.get(p, 0) for p in range(4, 8)) == 0, \
        f"pixels in pages a 32-row panel doesn't scan out: {lit}"
    ops = screen.stream()
    windows = sum(1 for k, b in ops if k == "cmd" and b == b"\x22")
    sent = sum(len(b) for k, b in ops if k == "data")
    assert windows and sent == 512 * windows, f"{sent} data bytes in {windows} refreshes"


def test_an_sh1107_panel_is_sent_16_pages_from_column_0(oled_media, screen):
    """LEDDisplayType 34 (128x128 I2C SH1107): the panel supply is enabled
    with 0xAD 0x8A, the display offset is 0, the frame is walked as 16
    pages from column 0 and never sent the 0x21/0x22 range commands, which
    on this controller switch it to vertical addressing.

    Regression: dba26147d (the SH1107 types). Before it type 34 did not
    exist, so fppoled drove such a panel with the SSD1327 sequence, which an
    SH1107 acknowledges and then leaves dark.
    """
    oled_media.settings(LEDDisplayType=34)
    screen.start()
    wait_for_bytes(screen, 2048 * 2)
    ops = screen.stream()
    cmds = b"".join(b for k, b in ops if k == "cmd")
    assert b"\xad\x8a" in cmds, cmds.hex()
    assert b"\xd3\x00" in cmds, f"display offset is not 0: {cmds.hex()}"
    assert b"\x21" not in cmds[cmds.index(b"\xad\x8a"):], \
        "a 0x21 after init selects vertical addressing on an SH1107"
    selects = [b[0] for k, b in ops if k == "cmd" and len(b) == 1 and 0xB0 <= b[0] <= 0xBF]
    assert set(selects) == set(range(0xB0, 0xC0)), sorted(set(selects))
    lows = {b[0] for k, b in ops if k == "cmd" and len(b) == 1 and b[0] < 0x10}
    assert lows == {0}, f"column low address {lows}: an SH1107 starts at column 0"
    pages, _ = oled.decode_stream(ops)
    assert sorted(pages) == list(range(16)), sorted(pages)
    assert sum(1 for x in pages[0] if x) > 0
