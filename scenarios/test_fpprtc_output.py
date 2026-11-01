"""What fpprtc, the boot-time RTC setup, prints from the commands it runs, in
the fppinit sandbox (fppinit.py).

The container has no modprobe, so the test stubs it where it is missing.
"""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture

# printf() conversions: printed as a format, they come out as numbers
# read off the stack.
NOT_A_FORMAT = "rtc-ds1307: %08x%08x %d loaded"


def test_a_commands_output_is_printed_as_text(fppinit):
    """modprobe's output (fpprtc loads the RTC's driver with it) is passed
    through as written, percent signs and all.

    Regression: 718cabad6. exec() handed each line of a command's output
    to printf() as the format string, so a line with a % in it printed
    whatever was on the stack instead (or crashed fpprtc for a %s or %n).
    The fix's other two slips are BeagleBone-only: getRTCDev() tested the
    literal "drv" for a BeagleBone Green Gateway's ds1307, and a misspelt
    PLATFORM_BB64 never copied the cape's time to a BB64's built-in RTC;
    this doesn't reach them.
    """
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    fppinit.stub_if_missing("/usr/sbin/modprobe", "/usr/sbin/hwclock")
    fppinit.settings(piRTC="2")
    fppinit.stub_output("modprobe", "rtc-ds1307", NOT_A_FORMAT + "\n")
    try:
        r = fppinit._run(["/opt/fpp/src/fpprtc"], timeout=30)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc never exited")
    assert "modprobe rtc-ds1307" in fppinit.calls(), fppinit.calls()
    assert NOT_A_FORMAT in r.stdout, f"rc {r.returncode}\n{r.stdout[-3000:]}{r.stderr[-2000:]}"
