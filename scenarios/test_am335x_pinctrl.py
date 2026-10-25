"""The tree's own pinctrl tool on an AM335x BeagleBone (BBB, PocketBeagle),
against a pinmux driver it can't damage: fakepinmux.c gives it a file for
/dev/am335xpm, the FPP kernel's driver for the control module's pad
registers, so a scenario sets a mode and reads the register back. With no
/dev/am335xpm the tool falls back to mapping /dev/mem, which under
run-local.sh is /dev/null.

Device only: run with run-local.sh on a BeagleBone Black or a
PocketBeagle, with capes/drivers/pinctrl built in the tree (make -C
capes/drivers/pinctrl pinctrl). Skipped elsewhere.
"""

import os
import struct
import subprocess

import pytest

from am335x import pocketbeagle, _am335x
import shims

CONF_BASE = 0x800  # the ball offset at /dev/am335xpm offset 0
INITIAL = 0x07     # mode 7 with no pull and no receiver: none of the modes set here

# PIN_INPUT_PULLUP | mode: AM335x.cpp's pad bits
INPUT_EN, PULL_UP, PULL_DISABLE = 0x20, 0x10, 0x08


class Pinmux:
    """A pad register file for one scenario, every pad at INITIAL."""

    def __init__(self, tmp_path, present=True):
        self.path = str(tmp_path / "am335xpm")
        with open(self.path, "wb") as f:
            f.write(struct.pack("<I", INITIAL) * (0x300 // 4))
        self.present = present

    def reg(self, ball_offset):
        with open(self.path, "rb") as f:
            f.seek(ball_offset - CONF_BASE)
            return struct.unpack("<I", f.read(4))[0]


def pinctrl(fppd, pinmux, *args):
    """Run the tree's pinctrl with `pinmux` as /dev/am335xpm (or none)."""
    if not os.environ.get("FPP_TESTS_BEAGLE") or not _am335x():
        pytest.skip("needs an AM335x BeagleBone under run-local.sh")
    tool = os.path.join(fppd.tree, "capes", "drivers", "pinctrl", "pinctrl")
    if not os.path.exists(tool):
        pytest.skip("the tree's pinctrl is not built (make -C capes/drivers/pinctrl pinctrl)")
    env = dict(os.environ, LD_PRELOAD=shims.build("fakepinmux.c"),
               FAKEPINMUX_FILE=pinmux.path if pinmux.present else "")
    return subprocess.run([tool, *args], env=env, capture_output=True, text=True, timeout=30)


def uart1_pins():
    """UART1 TX and RX: P2-09/P2-11 on a PocketBeagle, P9-24/P9-26 on a BBB."""
    return ("P2_09", "P2_11") if pocketbeagle() else ("P9_24", "P9_26")


UART1_TXD, UART1_RXD = 0x984, 0x980


def test_the_uart1_pads_can_be_muxed_to_i2c1(fppd, tmp_path):
    """"pinctrl -s <UART1 pin> i2c" muxes UART1_TXD and UART1_RXD to i2c1
    (mode 3, input with pull-up), as cape detection asks when it looks for
    an EEPROM on i2c1 (P2-09/P2-11 on a PocketBeagle).

    Regression: 16f937ee4. The AM335x table had no "i2c" mode on those
    balls, so the tool said "Unknown mode", exited 1, and the pads were
    never muxed.

    Also covers a58420ec3, which gave the tool its AM335x tables at all
    (with only the PocketBeagle2's, neither write lands).
    """
    pm = Pinmux(tmp_path)
    tx, rx = uart1_pins()
    for pin, ball in ((tx, UART1_TXD), (rx, UART1_RXD)):
        r = pinctrl(fppd, pm, "-s", pin, "i2c")
        assert r.returncode == 0, (pin, r.stdout, r.stderr)
        assert pm.reg(ball) == INPUT_EN | PULL_UP | 3, (pin, hex(pm.reg(ball)))


GPMC_CSN0 = 0x87c
GPMC_ADVN_ALE = 0x890  # P8-07


def needs_bbb():
    if pocketbeagle():
        pytest.skip("BeagleBone Black header pins")


def test_p8_26_is_a_pin(fppd, tmp_path):
    """P8_26 (GPMC_CSN0, gpio1_29) is in the BBB pin table: setting it to
    gpio_pd writes its pad register and a query names the mode.

    Regression: ba2656df8 (the P8_26 half). It was commented out with the
    eMMC pins P8_20-P8_25, so the tool answered "Unknown pin: P8_26".
    """
    needs_bbb()
    pm = Pinmux(tmp_path)
    r = pinctrl(fppd, pm, "-s", "P8_26", "gpio_pd")
    assert r.returncode == 0 and "Unknown pin" not in r.stdout, r.stdout
    assert pm.reg(GPMC_CSN0) == INPUT_EN | 7, hex(pm.reg(GPMC_CSN0))
    r = pinctrl(fppd, pm, "-q", "P8_26")
    assert "gpio_pd" in r.stdout, r.stdout


def test_a_query_survives_a_dev_mem_that_cannot_be_mapped(fppd, tmp_path):
    """With no /dev/am335xpm and a /dev/mem that cannot be mapped (here
    /dev/null), a pin query and a set return normally instead of
    crashing.

    Regression: ba2656df8 (the /dev/mem half). mmap()'s MAP_FAILED was
    stored as the domain address, sailed past the null check, and the
    first register read segfaulted.
    """
    pm = Pinmux(tmp_path, present=False)
    tx, _ = uart1_pins()
    for args in (("-q", tx), ("-s", tx, "gpio")):
        r = pinctrl(fppd, pm, *args)
        assert r.returncode >= 0, (args, f"killed by signal {-r.returncode}", r.stdout)


def test_pad_writes_go_through_the_pinmux_driver(fppd, tmp_path):
    """Where /dev/am335xpm exists, setting a pad to gpio_pu and then gpio_pd
    writes each mode's value into its register through the driver, and a
    query reads the mode back.

    Regression: 65075f51d. The pad registers were only written through a
    /dev/mem mapping, which the control module ignores from userspace (and
    which can't be mapped here), so no mode ever changed.
    """
    pm = Pinmux(tmp_path)
    tx, _ = uart1_pins()
    for mode, value in (("gpio_pu", INPUT_EN | PULL_UP | 7), ("gpio_pd", INPUT_EN | 7)):
        r = pinctrl(fppd, pm, "-s", tx, mode)
        assert r.returncode == 0, r.stdout
        assert pm.reg(UART1_TXD) == value, (mode, hex(pm.reg(UART1_TXD)))
        r = pinctrl(fppd, pm, "-q", tx)
        assert mode in r.stdout.split(), (mode, r.stdout)


def test_bbb_header_pins_take_the_names_fpp_uses(fppd, tmp_path):
    """The BBB's P8/P9 header pins answer to the underscore names fppd
    passes ("pinctrl -s P8_07 gpio_pu"), in each gpio mode, and read back
    the mode they were set to.

    Regression: 0eaa7eb5b. P8/P9 pins were registered as "P8-07", so every
    call fppd made for a BBB header pin named an unknown pin.
    """
    needs_bbb()
    pm = Pinmux(tmp_path)
    for mode, value in (("gpio", INPUT_EN | PULL_DISABLE | 7), ("gpio_pu", INPUT_EN | PULL_UP | 7),
                        ("gpio_pd", INPUT_EN | 7)):
        r = pinctrl(fppd, pm, "-s", "P8_07", mode)
        assert r.returncode == 0 and "Unknown" not in r.stdout, (mode, r.stdout)
        assert pm.reg(GPMC_ADVN_ALE) == value, (mode, hex(pm.reg(GPMC_ADVN_ALE)))
        assert mode in pinctrl(fppd, pm, "-q", "P8_07").stdout.split()


def test_an_unknown_mode_fails(fppd, tmp_path):
    """"pinctrl -s <pin> <a mode the pin lacks>" exits non-zero and leaves
    the pad as it was, so a caller that checks (CapeUtils) knows the mux
    did not change.

    Regression: 183327680 (the pinctrl half). An unknown mode printed a
    complaint and exited 0.
    """
    pm = Pinmux(tmp_path)
    tx, _ = uart1_pins()
    r = pinctrl(fppd, pm, "-s", tx, "no_such_mode")
    assert r.returncode != 0, r.stdout
    assert pm.reg(UART1_TXD) == INITIAL, hex(pm.reg(UART1_TXD))
