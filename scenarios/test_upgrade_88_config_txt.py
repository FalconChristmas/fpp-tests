"""Upgrade 88 on a Raspberry Pi: the KMS overlay it adds to config.txt."""

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_upgrade_steps import boot_write, step


def test_upgrade_88_opens_the_all_section_in_lower_case(fppinit):
    """The step appends the vc4-kms-v3d overlay to config.txt under an
    "[all]" section header written in lower case, once.

    Regression: 713562941. The header was "[ALL]"; the Pi firmware's
    config.txt filters are lower case ("[all]", "[pi4]"), so the overlay
    sat in a section that no board's conditions closed or matched as
    intended.
    """
    fppinit.root_file("/etc/fpp/platform", "Raspberry Pi\n")
    # make would build and install the cape drivers from the tree
    fppinit.root_file("/usr/bin/make", "#!/bin/sh\nexit 0\n")
    boot_write(fppinit, "config.txt", "arm_64bit=1\n")
    boot_write(fppinit, "cmdline.txt", "console=serial0,115200 root=/dev/mmcblk0p2\n")
    r, out = step(fppinit, 88)
    config = fppinit.boot_file("config.txt")
    # The control: the step got to the overlay line.
    assert "dtoverlay=vc4-kms-v3d" in config, f"the step did not add the overlay:\n{config}\n{out[-2000:]}"
    lines = config.splitlines()
    assert "[all]" in lines, f"no lower-case [all] header:\n{config}"
    assert "[ALL]" not in lines, config
    assert lines.index("[all]") < lines.index("dtoverlay=vc4-kms-v3d"), config
