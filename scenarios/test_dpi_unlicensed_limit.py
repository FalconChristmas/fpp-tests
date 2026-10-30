"""DPIPixels' 50-pixel limit on the ports past the two a Pi drives without
a licence.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built only
there). run-local.sh presents no signed cape, so DPIPixels has no licence and
allows two full outputs. fakedrm.so gives it a DPI panel, as in
test_dpi_refresh.py; the cape config goes to run-local.sh's overlay of
/opt/fpp/capes.
"""

import pytest

import fakedrm
from test_dpi_pixels import on_pi, write_cape
from test_dpi_refresh import string

pytestmark = pytest.mark.skipif(not on_pi(), reason="DPIPixels is built for a Raspberry Pi")


def licence_warnings(fppd):
    return [w for w in fppd.get("/fppd/status").get("warnings", []) if "DPIPixels is licensed for" in w]


@pytest.mark.parametrize("pixels,listed", [(50, False), (51, True)], ids=["50px", "51px"])
def test_a_third_port_of_fifty_pixels_is_within_the_unlicensed_limit(fppd, pixels, listed):
    """Three ports with no licence: a third port of exactly 50 pixels is
    allowed, so no "DPIPixels is licensed for 2 outputs" warning names it;
    one of 51 pixels is over and is named (output 3).

    Regression: 7f99cbdd1. The limit check was "50 <= pixelCount", so a
    port of exactly 50 pixels was taken as over the limit and named in the
    warning, as though the unlicensed limit were 49.
    """
    write_cape("TestDPILimit", {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}, {"pin": "P1-31"}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestDPILimit", "enabled": 1, "startChannel": 1,
         "channelCount": 3 * 51 * 3, "outputCount": 3,
         "outputs": [string(0, 0, 10), string(1, 30, 10), string(2, 60, pixels)]}]})
    fppd.settings(LogLevel_ChannelOut="info")
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    warnings = licence_warnings(fppd)
    if listed:
        assert warnings and warnings[0].endswith("Output(s): 3"), warnings
    else:
        assert not warnings, warnings
