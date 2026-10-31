"""`fpprtc set`, what www/common/settings.php's SetHWClock() runs through
sudo after the date, time or RTC type is changed in the UI, in the fppinit
sandbox (fppinit.py): hwclock is a stub that records its calls."""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_set_writes_the_system_time_to_the_rtc(fppinit):
    """With an RTC selected and its /dev/rtcN present, `fpprtc set` writes
    the system clock to it (hwclock -w) and does not read it back (-s).

    Regression: 64c065d5c. piRTC moved from a script to the fpprtc program,
    and SetHWClock() in settings.php became `sudo fpprtc set` for every
    platform; if "set" fell through to the boot-time path the clock a user
    had just set would be overwritten from the RTC."""
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    fppinit.stub_if_missing("/usr/sbin/modprobe", "/usr/sbin/hwclock")
    fppinit.settings(piRTC="2")
    fppinit.root_file("/dev/rtc0", "")
    try:
        r = fppinit._run(["/opt/fpp/src/fpprtc", "set"], timeout=30, media_home=True)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc set never exited")
    out = r.stdout + r.stderr
    hw = [c for c in fppinit.calls() if c.startswith("hwclock")]
    assert any(c.split()[:3] == ["hwclock", "-w", "-f"] and c.endswith("/dev/rtc0") for c in hw), f"{hw}\n{out}"
    assert not [c for c in hw if c.split()[1] == "-s"], f"{hw}\n{out}"
