"""fpprtc, the boot-time RTC setup, in the fppinit sandbox (fppinit.py).

fpprtc.service is a oneshot wanted by sysinit.target with no start timeout,
so if fpprtc never exits the box never finishes booting: no fppd, no web UI,
and nothing short of pulling the SD card gets it back.
"""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_a_configured_rtc_that_never_appears_does_not_hang_boot(fppinit):
    """With an RTC chip selected (piRTC) but none answering, /dev/rtcN never
    appears. The wait for it was meant to give up after 100 tries but never
    counted them, so fpprtc slept forever. The sandbox has no /dev/rtc* and
    a read-only /sys, which is exactly that case.

    Regression: 4517ed7fc. Also 64c065d5c: the piRTC script became fpprtc, and
    this is its selected-RTC path (a wrong piRTC key reads "None Selected")."""
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    fppinit.settings(piRTC="2")
    try:
        r = fppinit._run(["/opt/fpp/src/fpprtc"], timeout=30)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc never exited with an RTC configured and no chip present")
    out = r.stdout + r.stderr
    assert "terminate called" not in out and "AddressSanitizer" not in out, out[-3000:]
    assert "DS1307" in out, out[-3000:]
