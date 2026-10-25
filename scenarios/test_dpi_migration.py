"""An RPIWS281X string output, from before that driver was removed, on a Pi.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built only
there). fakedrm.so gives DPIPixels a DPI-1 connector, and run-local.sh's
pinctrl stub records the pads it muxes. The cape's string configs go to
/opt/fpp/capes/pi/strings, which run-local.sh overlays.
"""

import pytest

import fakedrm
import hosttools
from test_dpi_pixels import on_pi, write_cape
from test_dpi_refresh import string

pytestmark = pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")


def test_an_rpiws281x_pihat_config_runs_as_dpipixels_on_the_dpi_variant(fppd):
    """co-pixelStrings.json still names the removed RPIWS281X output with
    the PiHat cape, not yet migrated on disk: fppd loads it as DPIPixels,
    with the PiHat-DPIPixels string config in place of the old PiHat one,
    and drives the DPI variant's pins (GPIO4 and GPIO5 here) with no
    warning.

    Regression: e791964f5 (a feature: fppd's half; the boot-time migration
    on disk is test_fppinit.py's test_rpiws281x_strings_migrate_to_dpi).
    With the RPIWS281X driver gone, the type mapped to no output at all.
    The old PiHat config here names other pins (GPIO18 and GPIO12), so
    using it would show.
    """
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's pinctrl stub (no --host-pinctrl)")
    write_cape("PiHat", {"outputs": [{"pin": "P1-12"}, {"pin": "P1-32"}]})
    write_cape("PiHat-DPIPixels", {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "RPIWS281X", "subType": "PiHat", "enabled": 1, "startChannel": 1,
         "channelCount": 60, "outputCount": 2, "outputs": [string(0, 0), string(1, 30)]}]})
    fppd.settings(LogLevel_ChannelOut="info")
    preload, env = fakedrm.dpi_env(fppd)
    calls = hosttools.pinctrl_calls()
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="the RPIWS281X output to come up as DPIPixels on the fake DPI panel")
    assert "Mapped string config PiHat to PiHat-DPIPixels" in fppd.log(), fppd.tail()
    fppd.wait_for(lambda: [c for c in calls.calls() if c.split()[:2] == ["set", "5"]], timeout=5,
                  what="pinctrl to be asked to mux GPIO5")
    muxed = sorted({c.split()[1] for c in calls.calls() if c.split()[:1] == ["set"] and len(c.split()) > 2})
    assert muxed == ["4", "5"], muxed
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not [w for w in warnings if "DPI" in w or "RPIWS281X" in w], warnings
