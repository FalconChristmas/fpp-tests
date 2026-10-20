"""fppinit steps that only a Raspberry Pi build has (PLATFORM_PI), in the
fppinit sandbox. Device only: run with run-local.sh on a Pi.
"""

import os

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture


def on_pi():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith("Raspberry Pi")
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pi(), reason="a Raspberry Pi build of fppinit")

PARKED = "kernel_2712.img.fpp-disabled"
ACTIVE = "kernel_2712.img"


def test_the_16k_page_kernel_setting_moves_the_kernel(fppinit):
    """Pi16KPageKernel=1 puts the parked 16K-page kernel in place as
    kernel_2712.img without rebooting (the UI asks the user to), and 0
    parks it again.

    Regression: 05be6085e. Feature commit: before it there is no
    setup16KPageKernel action, and the 64-bit images either dropped the
    16K kernel or let a Pi 5 boot it unasked.
    """
    with open(os.path.join(fppinit.boot, PARKED), "wb") as f:
        f.write(b"16k kernel image")
    fppinit.write("settings", 'Pi16KPageKernel = "1"\n')
    fppinit.run("setup16KPageKernel")
    assert os.path.exists(os.path.join(fppinit.boot, ACTIVE)), os.listdir(fppinit.boot)
    with open(os.path.join(fppinit.boot, ACTIVE), "rb") as f:
        assert f.read() == b"16k kernel image"
    assert not any("reboot" in c for c in fppinit.calls()), fppinit.calls()

    fppinit.write("settings", 'Pi16KPageKernel = "0"\n')
    fppinit.run("setup16KPageKernel")
    assert not os.path.exists(os.path.join(fppinit.boot, ACTIVE)), os.listdir(fppinit.boot)
    assert os.path.exists(os.path.join(fppinit.boot, PARKED)), os.listdir(fppinit.boot)
