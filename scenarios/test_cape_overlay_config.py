"""Where fppcapedetect finds and how it fixes the cape overlay line in a Pi's
config.txt (the boot config), with no cape: the boot run makes sure config.txt
loads fpp-cape-overlay.

Pi only: that code is PLATFORM_PI's, which neither a container build nor a
BeagleBone compiles.
"""

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_cape_detect import detect, on_pi

pytestmark = pytest.mark.skipif(not on_pi(), reason="the cape overlay line is a Pi's config.txt")

OVERLAY = "dtoverlay=fpp-cape-overlay"


def test_a_wrong_cape_overlay_param_is_flipped_in_place(fppinit):
    """A config.txt left by FPP 9 has `dtparam=fpp-cape-overlay`, which
    loads nothing. The boot run turns that line into
    `dtoverlay=fpp-cape-overlay` where it stands, rather than adding a
    second line.

    Regression: 900e0d2b9. Nothing fixed the line; the overlay was never
    loaded on a box upgraded from FPP 9."""
    with open(f"{fppinit.boot}/config.txt", "w") as f:
        f.write("[all]\ndtparam=audio=on\ndtparam=fpp-cape-overlay\ndtparam=i2c_arm=on\n")
    detect(fppinit)
    cfg = fppinit.boot_file("config.txt")
    assert "dtparam=fpp-cape-overlay" not in cfg, cfg
    assert cfg.count(OVERLAY) == 1, cfg
    assert cfg.index("dtparam=audio=on") < cfg.index(OVERLAY) < cfg.index("dtparam=i2c_arm=on"), cfg


def test_the_boot_config_is_looked_for_in_firmware_first(fppinit):
    """With a config.txt in /boot/firmware and another in /boot, the boot
    run edits the one in /boot/firmware, and leaves /boot's alone.

    Regression: 8724869da. The directory was fixed when fppd was built,
    so a binary built on another machine edited whichever it had seen."""
    fppinit.root_file("/boot/config.txt", "[all]\ndtparam=audio=on\n")
    with open(f"{fppinit.boot}/config.txt", "w") as f:
        f.write("[all]\ndtparam=audio=on\n")
    detect(fppinit)
    assert OVERLAY in fppinit.boot_file("config.txt")
    assert OVERLAY not in (fppinit.written("/boot/config.txt") or ""), \
        "the config.txt in /boot was edited as well"


def test_the_boot_config_is_found_in_boot_when_firmware_has_none(fppinit):
    """With no config.txt in /boot/firmware, the one in /boot is the boot
    config: the overlay line lands there.

    Regression: 8724869da. The boot directory was whichever the build host
    had, so a binary built where /boot/firmware held a config.txt looked
    only there on a box whose config.txt is in /boot."""
    fppinit.root_file("/boot/config.txt", "[all]\ndtparam=audio=on\n")
    detect(fppinit)
    written = fppinit.written("/boot/config.txt")
    assert written is not None and OVERLAY in written, written
