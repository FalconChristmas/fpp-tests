"""fppoled's panel geometry for the display types other than the plain
128x64 SSD1306: the flipped 128x32 and the 128x128 SH1107.

fppoled draws into a framebuffer and pushes it to the panel over i2c; the
fake panel (fakessd1306.c) records every transaction, and oled.decode_stream()
replays them the way a page-addressed controller would. A real display can't
be read back over i2c, so what these pin is what fppoled sends.

Device only: run-local.sh on a Pi or Beagle (fppoled isn't built in a
container).
"""

import os
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


@pytest.mark.parametrize("display_type", [14, 15], ids=["16x2", "20x4"])
def test_a_pcf8574_lcd_is_looked_for_and_registered_at_0x27(oled_media, screen, tmp_path, display_type):
    """LEDDisplayType 14 and 15 (PCF8574 16x2 / 20x4 LCD, I2C 0x27): fppoled
    probes its default I2C bus (2 on a BeagleBone, 1 on a Pi, 0 elsewhere)
    for 0x27 and, finding it, registers a pcf8574 there (new_device
    "pcf8574 0x27"), whose lines it then drives the LCD with.

    Regression: 6b4c865d3 ("Add support for PCF8574 (non-A) to fix #1269").
    Only the PCF8574A's 0x3F was known: an LCD on a plain PCF8574, at 0x27,
    was never found.

    i2cdetect is a stand-in that answers only for 0x27 and logs each probe;
    fakesys.c serves /sys/bus/i2c/devices from a scratch directory, so the
    kernel's real new_device is not written.
    """
    import shims
    bindir, devices = tmp_path / "bin", tmp_path / "i2c-devices"
    bindir.mkdir()
    for bus in (0, 1, 2):
        (devices / f"i2c-{bus}").mkdir(parents=True)
        (devices / f"i2c-{bus}" / "new_device").write_text("")
    probes = tmp_path / "probes.txt"
    stub = bindir / "i2cdetect"
    stub.write_text(f'#!/bin/sh\necho "$*" >> {probes}\n'
                    'if [ "$4" = 0x27 ]; then echo "20:                      27"; '
                    'else echo "20:                      --"; fi\n')
    stub.chmod(0o755)
    oled_media.settings(LEDDisplayType=display_type)
    screen.start(preload=[shims.build("fakesys.c")],
                 extra_env={"PATH": f"{bindir}:{os.environ['PATH']}",
                            "FAKESYS": f"/sys/bus/i2c/devices={devices}"})
    new_devices = [devices / f"i2c-{bus}" / "new_device" for bus in (0, 1, 2)]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and not any(d.read_text() for d in new_devices):
        time.sleep(0.2)
    seen = probes.read_text() if probes.exists() else ""
    written = {d.parent.name: d.read_text() for d in new_devices if d.read_text()}
    # the platform's default bus is probed first, and the device is
    # registered on the bus that answered, and only there
    assert written and set(written.values()) == {"pcf8574 0x27"} and len(written) == 1, \
        f"registered: {written}\nprobes:\n{seen}\n{screen.log()}"
    bus = next(iter(written)).split("-")[1]
    assert seen.splitlines()[0] == f"-y -r {bus} 0x27 0x27", seen
