"""The older LED panel driver (BBBMatrix, the LEDscapeMatrix subtype) on a
PocketBeagle2, for the original PocketScroller capes: how it splits the work
between the PRUs. Against PRUs that never answer (see bbcape.py); the panel
pinout is the cape's own, from /home/fpp/media/tmp/panels, which BBBMatrix
reads before the ones under /opt/fpp/capes.

Device only: run with run-local.sh on a PocketBeagle2. The GPIO lines are the
real ones, so stop the device's own fppd first. Skipped elsewhere.
"""

import json
import os

from bbcape import fake_pru
from test_am335x_pru import matrix_config, pru_builds

PANELS = "/home/fpp/media/tmp/panels"


def pocketscroller_pinout(fppd, **over):
    """The image's PocketScroller pinout cut to its first output, as the
    cape's own (under both names BBBMatrix looks for)."""
    with open("/opt/fpp/capes/pb/panels/PocketScroller.json") as f:
        p = json.load(f)
    p["outputs"] = p["outputs"][:1]
    p.update(over)
    os.makedirs(PANELS, exist_ok=True)
    for name in ("PocketScroller", "Octoscroller"):
        with open(os.path.join(PANELS, name + ".json"), "w") as f:
            json.dump(dict(p, name=name), f, indent=4)


def test_a_pinout_that_does_not_ask_for_one_pru_gets_the_copy_program(fppd):
    """A PocketScroller pinout with no "singlePRU" on a PocketBeagle2: the
    panel program is built for two PRUs (no -DSINGLEPRU) and the copy
    program is started on the other core, as on a PocketBeagle.

    Regression: 2c7782b86 (its BBBMatrix.cpp half; the clock flush and the
    copy program's timing are electrical). BB64 builds forced m_singlePRU
    on ("PRU -> PRU data transfer not working yet"), whatever the pinout
    said.
    """
    fake_pru(fppd)
    pocketscroller_pinout(fppd)
    fppd.write("config/channeloutputs.json", matrix_config())
    fppd.settings(LogLevel_ChannelOut="debug")
    fppd.start(timeout=90)
    fppd.wait_for(lambda: pru_builds(fppd, "compileMatrix.sh"), timeout=60,
                  what=f"the panel program build ({fppd.tail()})")
    args = pru_builds(fppd, "compileMatrix.sh")[-1]
    assert "-DSINGLEPRU" not in args, args
    fppd.wait_for(lambda: "run(/tmp/FalconMatrixPRUCpy.out)" in fppd.log(), timeout=30,
                  what=f"the copy program to start ({fppd.tail()})")
