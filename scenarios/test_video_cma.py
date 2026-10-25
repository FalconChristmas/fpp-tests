"""HDMI video consumers when the kernel's CMA pool reads low.

Runs anywhere, Docker included: the display is the stand-in kmssink of
fakekms.c (test_video.fake_kms_env()), and fakesys.c serves fppd a
/proc/meminfo whose CmaFree is what the scenario says.
"""

import os

import shims
from test_video import fake_kms_env, hdmi_consumer, kms_events, setup, source


def test_a_camera_starts_on_hdmi_though_cma_free_reads_low(fppd, audio):
    """A camera group on HDMI with /proc/meminfo saying CmaFree is 1024 kB,
    under the 20 MB kmssink wants: fppd warns and starts the camera anyway,
    and its frames reach the display.

    Regression: 72063740a (its CMA half). The consumer was skipped outright
    ("CMA memory too low ... Restart FPPD to recover CMA"), but CmaFree
    reads low whenever the kernel has lent CMA pages to ordinary movable
    allocations, which it migrates back on a real DMA allocation: cameras
    on a busy Pi stayed dark for nothing.
    """
    setup(fppd, [hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)],
          [source("videotestsrc", pattern="smpte")])
    meminfo = fppd.write("tmp/meminfo", "MemTotal:        4045000 kB\nMemFree:         2000000 kB\n"
                         "CmaTotal:          262144 kB\nCmaFree:             1024 kB\n")
    env = fake_kms_env(fppd)
    env["FAKESYS"] = f"/proc/meminfo={meminfo}"
    fppd.settings(LogLevel_MediaOut="info")
    fppd.start(preload=[shims.build("fakesys.c")], extra_env=env)
    fppd.wait_for(lambda: [e for e in kms_events(fppd) if e[0] == "frame" and e[2] == 77],
                  timeout=20, what="the camera's frames on the display")
    # The control: fppd really read the faked pool as low.
    assert "CMA low (1024 kB)" in fppd.log(), fppd.tail()
