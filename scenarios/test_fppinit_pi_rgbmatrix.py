"""fppinit's setupChannelOutputs and the onboard sound driver, on a Pi build
of fppinit (PLATFORM_PI), in the fppinit sandbox. Device only: run with
run-local.sh on a Pi.
"""

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_pi import on_pi, reboots

pytestmark = pytest.mark.skipif(not on_pi(), reason="a Raspberry Pi build of fppinit")

BLACKLIST = "/etc/modprobe.d/blacklist-bcm2835.conf"


def matrix_output(enabled):
    return {"channelOutputs": [{"type": "LEDPanelMatrix", "subType": "RGBMatrix", "enabled": enabled,
                                "startChannel": 1, "channelCount": 0}]}


def test_an_enabled_rgbmatrix_output_blacklists_the_onboard_sound_driver(fppinit):
    """With an RGBMatrix output enabled in channeloutputs.json, boot
    blacklists snd_bcm2835 and loads the dummy sound driver in its place, and
    asks for a reboot; with the output off it takes the blacklist away and
    loads snd-bcm2835 again.

    Regression: 6274fbf57. The boot step looked for channelOutputs.json, a
    file name that is not the one FPP writes (channeloutputs.json), so it
    never saw the output and left the sound driver loaded for the panel
    library to fight over."""
    fppinit.write("config/channeloutputs.json", matrix_output(1))
    fppinit.run("setupChannelOutputs")
    assert fppinit.written(BLACKLIST) == "blacklist snd_bcm2835", fppinit.calls()
    assert [c for c in fppinit.calls() if "modprobe" in c and "snd-dummy" in c], fppinit.calls()
    assert reboots(fppinit), fppinit.calls()

    fppinit.write("config/channeloutputs.json", matrix_output(0))
    fppinit.run("setupChannelOutputs")
    assert [c for c in fppinit.calls() if "modprobe" in c and "snd-bcm2835" in c], fppinit.calls()
    assert not [c for c in fppinit.calls() if "snd-dummy" in c], fppinit.calls()
