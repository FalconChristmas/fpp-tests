"""postNetwork's late swap-on of the disk swap partition the image ships
(fstab "noauto", so systemd leaves it for fppinit to bring up).
"""

from fppinit import MEDIA, fppinit  # noqa: F401 -- the fixture
from test_fppinit import assert_clean
from test_fppinit_network_boot import run


def test_postnetwork_swaps_on_the_disk_swap_partition_but_not_zram(fppinit):
    """postNetwork runs swapon for each swap line of /etc/fstab that is not
    a zram device, and for nothing else.

    Feature: 5fc3d79c2 (startDiskSwap). The partition is marked noauto so
    that boot does not wait on it; before the commit nothing brought it up
    and a box only ever swapped to zram."""
    fppinit.settings(bootDelay="0")
    fppinit.root_file("/etc/fstab",
                      "/dev/mmcblk0p1 /boot vfat defaults 0 2\n"
                      "/dev/mmcblk0p2 none swap sw,noauto 0 0\n"
                      "/dev/zram0 none swap sw 0 0\n")
    fppinit.root_file("/sbin/swapon", f"#!/bin/sh\necho \"$*\" >> {MEDIA}/tmp/swapon-ran\n")
    assert_clean(run(fppinit, "postNetwork", net=True))
    assert fppinit.media_exists("tmp/swapon-ran"), "swapon was never run for the disk swap partition"
    assert fppinit.media_file("tmp/swapon-ran") == "/dev/mmcblk0p2\n", fppinit.media_file("tmp/swapon-ran")
