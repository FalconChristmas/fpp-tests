"""Upgrade 88 on a Raspberry Pi: the cape overlays it builds."""

import os

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_upgrade_steps import boot_write, step


def test_upgrade_88_installs_the_cape_overlays(fppinit):
    """The step runs "make install" and then "make clean" in
    capes/drivers/pi, the Pi's overlay sources, so the overlays the new
    config.txt names exist in the boot directory.

    Regression: 812d74a7e. The step rewrote config.txt for the KMS overlay
    but never built the cape overlays, so a Pi upgraded from an older image
    kept the old overlay set until the next OS image.
    """
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    # A make that only says where and with what it was run
    fppinit.root_file("/usr/bin/make", '#!/bin/sh\necho "$PWD $*" >> /make-calls.log\nexit 0\n')
    boot_write(fppinit, "config.txt", "arm_64bit=1\n")
    boot_write(fppinit, "cmdline.txt", "console=serial0,115200 root=/dev/mmcblk0p2\n")
    r, out = step(fppinit, 88)
    config = fppinit.boot_file("config.txt")
    # The control: the step ran to the end (it got as far as the overlay line).
    assert "dtoverlay=vc4-kms-v3d" in config, f"the step did not add the overlay:\n{config}\n{out[-2000:]}"
    log = os.path.join(fppinit.upper, "make-calls.log")
    assert os.path.exists(log), f"the step never ran make:\n{out[-2000:]}"
    with open(log) as f:
        made = [l.strip() for l in f if l.strip()]
    drivers = "/opt/fpp/capes/drivers/pi"
    assert f"{drivers} install" in made, made
    assert f"{drivers} clean" in made, made
    assert made.index(f"{drivers} install") < made.index(f"{drivers} clean"), made
