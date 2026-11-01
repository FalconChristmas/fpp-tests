"""The tree's own pinctrl tool for a PocketBeagle2 (AM62x), against pad
registers it can't damage: fakepadmem.c gives it a sparse file for
/dev/mem, so the MCU and MAIN domain pad registers it maps are file
offsets, and a scenario sets a mode and reads the register value back --
the value the pad would be given. The board model is faked as well, so
this runs wherever the tool is built (run-local.sh on a Beagle, with
capes/drivers/pinctrl built in the tree: make -C capes/drivers/pinctrl
pinctrl). Skipped elsewhere.
"""

import os
import struct
import subprocess

import pytest

import shims

DOMAINS = {"mcu": 0x4084000, "main": 0xF4000}  # where AM6232.cpp maps each domain

# AM6232.cpp's pad bits
INPUT_EN, ST_ENABLE, PULL_DISABLE, PULL_UP = 1 << 18, 1 << 14, 1 << 16, 1 << 17
GPIO = INPUT_EN | ST_ENABLE | PULL_DISABLE | 7
GPIO_OUT = PULL_DISABLE | 7
RESET = 0x8214007


def output(mode):
    return PULL_DISABLE | mode


class Pads:
    """A sparse file standing in for /dev/mem, every pad register zero."""

    def __init__(self, tmp_path):
        self.path = str(tmp_path / "mem")
        with open(self.path, "wb") as f:
            f.truncate(DOMAINS["mcu"] + 0x1000)
        self.model = str(tmp_path / "model")
        with open(self.model, "wb") as f:
            f.write(b"BeagleBoard.org PocketBeagle2\0")

    def reg(self, domain, offset):
        with open(self.path, "rb") as f:
            f.seek(DOMAINS[domain] + offset)
            return struct.unpack("<I", f.read(4))[0]


@pytest.fixture
def pads(tmp_path):
    return Pads(tmp_path)


def pinctrl(pads, *args):
    tree = os.environ.get("FPP_TREE", "")
    tool = os.path.join(tree, "capes", "drivers", "pinctrl", "pinctrl")
    if not tree or not os.path.exists(tool):
        pytest.skip("the tree's pinctrl is not built (make -C capes/drivers/pinctrl pinctrl)")
    env = dict(os.environ, LD_PRELOAD=shims.build("fakepadmem.c"),
               FAKEPADMEM_FILE=pads.path, FAKEPADMEM_MODEL=pads.model)
    return subprocess.run([tool, *args], env=env, capture_output=True, text=True, timeout=30)


def set_mode(pads, pin, mode):
    r = pinctrl(pads, "-s", pin, mode)
    assert r.returncode == 0, f"pinctrl -s {pin} {mode}: {r.stdout}{r.stderr}"


def current_mode(pads, pin):
    """The mode -l marks as current, [like_this]."""
    r = pinctrl(pads, "-l", pin)
    assert r.returncode == 0, r.stdout + r.stderr
    marked = [w for w in r.stdout.split() if w.startswith("[") and w.endswith("]")]
    return marked[0][1:-1] if marked else None


def test_the_mspm0_reset_and_boot_pins_can_be_driven(pads):
    """NRST (ball C20, MAIN pad 0x254) and BSL_Invoke (ball B8, MCU pad
    0x004), the PB2's own lines to its MSPM0 co-processor, are pins the
    tool knows: setting them writes their pads, so the MSPM0 can be held
    in reset or put in its bootloader to be reflashed.

    Feature: 5d1966667."""
    set_mode(pads, "NRST", "gpio_out")
    assert pads.reg("main", 0x254) == GPIO_OUT, hex(pads.reg("main", 0x254))
    set_mode(pads, "BSL_Invoke", "gpio")
    assert pads.reg("mcu", 0x004) == GPIO, hex(pads.reg("mcu", 0x004))


def test_p2_31_takes_its_modes_from_both_its_balls_and_reports_the_one_set(pads):
    """P2_31 is wired to two balls: A13 (MAIN 0x1B4), which has the GPIO and
    PWM modes, and AA18 (0x170), which has the PRU's. Its PWM mode muxes A13
    and parks AA18 at reset; its PRU mode muxes AA18. -l then reports PWM as
    the current mode.

    Regression: 7b70a09f9 (the modes came from AA18 only, so "pwm" was
    unknown and gpio went to the wrong ball) and 80ec87693 (with AA18
    listed first, its reset state was what -l reported).
    Also 6363b1195: the tool's first pin table, whose AA18 entry (0x170)
    this reads."""
    set_mode(pads, "P2_31", "pwm")
    assert pads.reg("main", 0x1B4) == output(2), hex(pads.reg("main", 0x1B4))
    assert pads.reg("main", 0x170) == RESET, hex(pads.reg("main", 0x170))
    assert current_mode(pads, "P2_31") == "pwm"
    set_mode(pads, "P2_31", "pruout")
    assert pads.reg("main", 0x170) == output(3), hex(pads.reg("main", 0x170))
    assert pads.reg("main", 0x1B4) == RESET, hex(pads.reg("main", 0x1B4))


def test_p1_04_drives_ball_d20(pads):
    """P1_04 is ball D20 (MAIN 0x1A8) first, Y18 (0x16C) only for its PRU
    mode: gpio_out muxes D20 and parks Y18.

    Regression: 28f8796f5 (the pin configuration had the balls the other
    way round, so a K40 cape's P1_04 output never reached the header)."""
    set_mode(pads, "P1_04", "gpio_out")
    assert pads.reg("main", 0x1A8) == GPIO_OUT, hex(pads.reg("main", 0x1A8))
    assert pads.reg("main", 0x16C) == RESET, hex(pads.reg("main", 0x16C))


@pytest.mark.parametrize("pin,mode,domain,offset,mux", [
    ("P1_06", "pwm", "main", 0x1AC, 6),    # E19
    ("P1_30", "pwm", "main", 0x1CC, 3),    # E14
    ("P2_27", "pwm", "main", 0x1C0, 2),    # B13
    ("P1_02", "ecap", "main", 0x1A0, 1),   # E18
    ("P2_36", "ecap", "main", 0x1B8, 3),   # C13
])
def test_pwm_and_ecap_modes_mux_their_pads(pads, pin, mode, domain, offset, mux):
    """The ePWM and eCAP outputs a cape can use for PWM are pin modes: the
    pad gets that function's mux value, as an output.

    Feature: acb1865b3.
    Also 56829fe97: P1_06's entry in the pin table (it added most of the
    header pins; the other ones are unknown to the tool without it)."""
    set_mode(pads, pin, mode)
    assert pads.reg(domain, offset) == output(mux), hex(pads.reg(domain, offset))


def test_an_input_mode_enables_the_schmitt_trigger(pads):
    """A GPIO input (gpio, gpio_pu) is set with the pad's Schmitt trigger
    on (bit 14), as the kernel's own PIN_INPUT does, so a slow or noisy
    edge on a button or sensor line is read cleanly.

    Regression: b5d6529b0 (the pinctrl half: the input modes left ST_EN
    off)."""
    set_mode(pads, "P2_27", "gpio")
    assert pads.reg("main", 0x1C0) == GPIO, hex(pads.reg("main", 0x1C0))
    set_mode(pads, "P2_27", "gpio_pu")
    assert pads.reg("main", 0x1C0) == INPUT_EN | ST_ENABLE | PULL_UP | 7, hex(pads.reg("main", 0x1C0))
