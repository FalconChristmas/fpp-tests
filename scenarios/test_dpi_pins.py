"""The GPIO pads DPIPixels hands to the DPI peripheral, on a fake DPI panel.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built only
there). fakedrm.so stands in for the display card with a DPI-1 connector, so
DPIPixels gets through Init() to muxing its data pins, and run-local.sh's
pinctrl stub records the "pinctrl set" calls instead of re-muxing the pads.
"""

import os

import pytest

import fakedrm
import hosttools
import shims
from test_dpi_pixels import on_pi, write_cape
from test_dpi_refresh import setup

pytestmark = pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")


@pytest.mark.parametrize("model,alt", [("Raspberry Pi 5 Model B Rev 1.0", "a1"),
                                       ("Raspberry Pi 4 Model B Rev 1.5", "a2")],
                         ids=["pi5", "pi4"])
def test_dpi_data_pins_get_the_dpi_function_of_the_soc(fppd, model, alt):
    """DPIPixels' two strings on GPIO4 and GPIO5 (P1-7, P1-29): each pad is
    set to the SoC's DPI function, alt1 on a Pi 5's RP1 and alt2 on the
    BCM2711 and earlier.

    Regression: 58118066b. Every Pi got alt1, which on a Pi 4 is the
    secondary memory interface, so the strings there never saw the DPI.
    Also ce2e621f3, which first muxed a Pi 5's pins to alt1 for the DPI
    (the pi5 case): without it no pinctrl call reaches the pad.

    The board is told apart by /proc/device-tree/model; fakesys.so serves
    fppd the one this case names (so a Pi 5 can run the Pi 4 case).
    """
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (no --host-pinctrl)")
    setup(fppd)
    dt = os.path.join(fppd.media, "tmp", "device-tree")
    os.makedirs(dt)
    with open(os.path.join(dt, "model"), "wb") as f:
        f.write(model.encode() + b"\0")
    preload, env = fakedrm.dpi_env(fppd)
    env["FAKESYS"] = f"/proc/device-tree={dt}"
    calls = hosttools.pinctrl_calls()
    fppd.start(preload=preload + [shims.build("fakesys.c")], extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    fppd.wait_for(lambda: [c for c in calls.calls() if c.split()[:2] == ["set", "5"]], timeout=5,
                  what="pinctrl to be asked to mux GPIO5")
    sets = {tuple(c.split()[1:3]) for c in calls.calls() if c.split()[:1] == ["set"]}
    for gpio in ("4", "5"):
        assert (gpio, alt) in sets, f"GPIO{gpio} was not set to {alt}: {calls.calls()}"


def test_dpi_pads_are_parked_low_when_fppd_stops(fppd):
    """DPIPixels on GPIO4 and GPIO5; fppd is stopped: on the way out it
    takes both pads back from the DPI, parking each as an output driven low
    (the WS281x idle level), so the strings see no garbage while fppd is
    down or restarting.

    Regression: 315270c68. Close() left the pads muxed to the DPI, which
    went on scanning out whatever the display held as fppd exited and the
    next one started: the strings flashed random colours. Also guards
    0b9b67ff4: a pad released as a plain input floated, and the hat's buffer
    turned the noise into colours as well.
    """
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (no --host-pinctrl)")
    setup(fppd)
    preload, env = fakedrm.dpi_env(fppd)
    calls = hosttools.pinctrl_calls()
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: [c for c in calls.calls() if c.split()[:2] == ["set", "5"]], timeout=15,
                  what="DPIPixels to mux GPIO5 to the DPI")
    assert fppd.stop() == 0, fppd.tail()
    fppd.exit_expected = True
    last = {}
    for c in calls.calls():
        w = c.split()
        if w[:1] == ["set"] and len(w) > 2:
            last[w[1]] = " ".join(w[2:])
    assert last.get("4") == "op dl" and last.get("5") == "op dl", \
        f"the pads after fppd stopped: {last} ({calls.calls()})"
