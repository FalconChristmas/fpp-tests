"""DPIPixels' 50-pixel limit on the ports past the two a Pi drives without
a licence.

Device only: run with run-local.sh on a Raspberry Pi (DPIPixels is built only
there). run-local.sh presents no signed cape, so DPIPixels has no licence and
allows two full outputs. fakedrm.so gives it a DPI panel, as in
test_dpi_refresh.py; the cape config goes to run-local.sh's overlay of
/opt/fpp/capes.
"""

import re

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


def test_an_unlicensed_port_over_fifty_pixels_runs_fifty(fppd):
    """Three ports with no licence, the third configured for 60 pixels: the
    third string runs 50 pixels -- the limit is applied to the string
    itself, so the pixels past 50 are never sent -- and the licence warning
    names it.

    Regression: 0b3791af2 ("Update DPIPixels to use same max pixels logic as
    BBB48String"). The limit was applied in PrepData; since 315270c68
    PrepData no longer has it, so the string's own count is the only cap.
    The count read here is the one fppd's ChannelOut debug dump prints for
    each string after Init(), what PrepData then sends.
    """
    write_cape("TestDPILimit", {"outputs": [{"pin": "P1-7"}, {"pin": "P1-29"}, {"pin": "P1-31"}]})
    fppd.write("config/co-pixelStrings.json", {"channelOutputs": [
        {"type": "DPIPixels", "subType": "TestDPILimit", "enabled": 1, "startChannel": 1,
         "channelCount": 3 * 60 * 3, "outputCount": 3,
         "outputs": [string(0, 0, 10), string(1, 30, 10), string(2, 60, 60)]}]})
    fppd.settings(LogLevel_ChannelOut="debug")
    preload, env = fakedrm.dpi_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.wait_for(lambda: "DPIPixels: framebuffer 1920x" in fppd.log(), timeout=15,
                  what="DPIPixels to come up on the fake DPI panel")
    fppd.wait_for(lambda: "ChannelOutput::DumpConfig()" in fppd.log(), timeout=10,
                  what="the output's config dump")
    log = fppd.log()
    dump = log[log.index("port number      : 2"):]
    counts = re.findall(r"pixel count   : (\d+)", dump)
    assert counts[:1] == ["50"], dump[:1500]
    warnings = licence_warnings(fppd)
    assert warnings and warnings[0].endswith("Output(s): 3"), warnings
