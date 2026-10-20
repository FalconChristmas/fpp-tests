"""fpprtc reads the RTC choice (piRTC) from the settings file in either of
the forms the file holds it in, in the fppinit sandbox (fppinit.py)."""

import os
import subprocess

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture


def test_an_unquoted_rtc_setting_is_read(fppinit):
    """With the settings file holding piRTC unquoted ("piRTC = 2", the form
    it is written in now), fpprtc sets up the DS1307 that 2 selects.

    Regression: 31e60fbb7. fpprtc's own settings parser assumed a quoted
    value and read a byte past the digit, so the unquoted form gave a
    garbage choice: "None Selected", with no hwclock -s at boot and no
    daily RTC update.

    The settings file is at /home/fpp/media as well as at the media
    directory for this run, where fpprtc looked for it before the fix.
    fpprtc is not built in a container, so this runs with run-local.sh on
    a Pi or Beagle; verified there red (the old parser reinstated) and
    green."""
    if not os.path.exists(os.path.join(fppinit.tree, "src", "fpprtc")):
        pytest.skip("no fpprtc in the tree under test")
    with open(os.path.join(fppinit.media, "settings"), "a") as f:
        f.write("piRTC = 2\n")
    try:
        r = fppinit._run(["/opt/fpp/src/fpprtc"], timeout=30, media_home=True)
    except subprocess.TimeoutExpired:
        pytest.fail("fpprtc never exited with an RTC configured and no chip present")
    out = r.stdout + r.stderr
    assert "AddressSanitizer" not in out, out[-3000:]
    assert "DS1307" in out and "None Selected" not in out, out[-3000:]
