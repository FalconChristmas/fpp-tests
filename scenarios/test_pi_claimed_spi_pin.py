"""A cape's SPI1 data pin that a kernel driver holds and that can't be freed,
asked for again after an output reload.

Device only: run with run-local.sh on a Raspberry Pi (PiGPIOUtils and
DPIPixels are built only there). The claim is staged: a tmpfs over
/sys/kernel/debug (in the run's own mount namespace) carries a pin
controller whose pinmux-pins says a device holds GPIO20, a device with no
driver bound, so fppd can neither free it nor touch anything real. The
pads fppd asks to mux go to run-local.sh's pinctrl stub, whose log is the
receiving end here: a "pinctrl set" on a pin the kernel still holds
re-muxes it behind the driver's back on a real board. fakedrm.so gives
DPIPixels its DPI panel, as in test_dpi_refresh.py.
"""

import os
import subprocess
import time

import pytest

import fakedrm
import hosttools
from test_dpi_pixels import on_pi, write_cape
from test_dpi_refresh import string

pytestmark = pytest.mark.skipif(not on_pi(), reason="PiGPIOUtils is built for a Raspberry Pi")

HOLDER = "fpp-tests-i2s"  # no such platform device: nothing to unbind


@pytest.fixture
def claimed_gpio20():
    """/sys/kernel/debug/pinctrl with GPIO20 held by HOLDER, every other
    header pin unclaimed."""
    r = subprocess.run(["mount", "-t", "tmpfs", "tmpfs", "/sys/kernel/debug"],
                       capture_output=True, text=True)
    if r.returncode:
        pytest.skip("cannot mount over /sys/kernel/debug here: " + r.stderr.strip())
    try:
        d = "/sys/kernel/debug/pinctrl/1f000d0000.gpio-pinctrl-rp1"
        os.makedirs(d)
        with open(os.path.join(d, "pinmux-pins"), "w") as f:
            for g in range(54):
                if g == 20:
                    f.write(f"pin 20 (gpio20): device {HOLDER} function i2s0 group gpio20\n")
                else:
                    f.write(f"pin {g} (gpio{g}): UNCLAIMED\n")
        yield
    finally:
        subprocess.run(["umount", "/sys/kernel/debug"])


def config(pixels):
    return {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestSPIPin", "enabled": 1, "startChannel": 1,
         "channelCount": 60, "outputCount": 2,
         "outputs": [string(0, 0, pixels), string(1, 30, pixels)]}]}


def test_a_held_spi_pin_is_refused_again_after_a_reload(claimed_gpio20, fppd):
    """A cape whose string config asks for P1-38 (GPIO20, SPI1 MOSI) in
    its SPI mode, on a board where another device holds that pin and has
    no driver to unbind: the pin is refused with a warning and never
    muxed, and when a save of co-pixelStrings.json reloads the output and
    the pin is asked for again, it is refused again -- still no "pinctrl
    set 20" to the SPI function.

    Regression: cd15a51c3. releasePinFromKernelDriver() remembered the
    pins it had dealt with and answered "freed" for any of them on a later
    call, including one it had failed to free; the reloaded output then
    muxed GPIO20 to SPI under the driver that holds it.
    """
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (no --host-pinctrl)")
    write_cape("TestSPIPin", {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}],
                              "gpios": [{"pin": "P1-38", "mode": "spi"}]})
    fppd.write("config/co-pixelStrings.json", config(10))
    fppd.settings(LogLevel_ChannelOut="debug", LogLevel_GPIO="debug")
    calls = hosttools.pinctrl_calls()
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    fppd.wait_for(lambda: "Pin P1-38 is claimed by" in fppd.log(), timeout=5,
                  what="the refusal of P1-38")
    assert f"claimed by {HOLDER} (i2s0) and cannot be used for SPI" in fppd.log(), fppd.tail()

    def muxed_20():
        # SPI1 is alt0 on a Pi 5's RP1, alt4 on the older SoCs; the reload's
        # release of the pin ("set 20 no"/"ip") is not a mux to SPI
        return [c for c in calls.calls() if c.split()[:3] in (["set", "20", "a0"], ["set", "20", "a4"])]

    def dpi_muxes():
        return len([c for c in calls.calls() if c.split()[:2] == ["set", "4"] and c.split()[2] in ("a1", "a2")])

    assert not muxed_20(), calls.calls()
    fppd.write("config/co-pixelStrings.json", config(12))
    fppd.wait_for(lambda: dpi_muxes() >= 2, timeout=15,
                  what="the reloaded output to mux its data pins again")
    # its Init asks for the cape's gpios right after the data pins
    time.sleep(1)
    assert not muxed_20(), f"GPIO20 muxed while its holder still has it: {muxed_20()}"
