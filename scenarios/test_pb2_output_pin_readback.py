"""A pixel port's enable pin on a PocketBeagle2 header pin, read back.

An AM62x pad muxed as a GPIO output (pinctrl's gpio_out) has its receiver
off, so the line reads 0 whatever it drives: fppd answers a read of an
output line with the value it last wrote. What reads it is the port's
"enabled" in /fppd/ports. The port is PixelCountSim's (as in
test_efuse_ports.py) with its enable pin on P2-25, a plain GPIO pad a
K16-Pro leaves parked; nothing is wired to it.

Device only: run-local.sh --host-pinctrl on a PocketBeagle2 (the stub
pinctrl would leave the pad's receiver on, and the read would see the
line). The pad is put back as it was after fppd stops. Skipped elsewhere.
"""

import subprocess

import pytest

import hosttools
from test_efuse_ports import config
import throw_plugin

PIN, BALL_PIN = "P2-25", "P2_25"


def on_pb2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


def pad_mode():
    """The pad's current mode as the real pinctrl marks it, [like_this]."""
    out = subprocess.run([hosttools.real("pinctrl"), "-l", BALL_PIN], capture_output=True, text=True).stdout
    marked = [w[1:-1] for w in out.split() if w.startswith("[") and w.endswith("]")]
    return marked[0] if marked else None


@pytest.fixture
def pad():
    if not on_pb2():
        pytest.skip("needs a PocketBeagle2")
    if hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh --host-pinctrl: the stub leaves the pad's receiver on")
    before = pad_mode()
    if before not in ("reset", "gpio"):
        pytest.skip(f"{BALL_PIN} is in use here ({before})")
    try:
        yield
    finally:
        subprocess.run([hosttools.real("pinctrl"), "-s", BALL_PIN, before])
    assert pad_mode() == before


def test_an_enable_pin_on_a_pb2_output_pad_reads_back_as_driven(pad, fppd):
    """With the outputs on, the port whose enable pin is P2-25 reports
    enabled, while the pad is a GPIO output (receiver off).

    Regression: 3a778e0e3. The read went to the line, which on such a pad
    is always 0: every enabled PB2 port reported off."""
    cfg = config(fppd)
    cfg["channelOutputs"][0]["outputs"][0]["simPin"] = {"enablePin": PIN}
    throw_plugin.install(fppd, source="pixelcountsim.cpp", name="PixelCountSim")
    fppd.write(fppd.strings_config, cfg)
    fppd.start()
    fppd.command("Outputs On")

    def port():
        return next((p for p in fppd.get("/fppd/ports") or [] if p.get("name") == "Port 1"), None)

    fppd.wait_for(lambda: port() is not None, timeout=10, what="Port 1 to be monitored")
    assert pad_mode() == "gpio_out", f"{BALL_PIN} is {pad_mode()}, not a GPIO output"
    fppd.wait_for(lambda: port().get("enabled") is True, timeout=10,
                  what=f"Port 1 to report enabled (it reports {port()})")
