"""The WiFi antenna setting of a Compute Module 4/5 (PCB antenna or U.FL
socket) in the fppinit sandbox. Device only: a Raspberry Pi build of
fppinit, run with run-local.sh on a Pi; the module's ant2 device tree
parameter is faked.
"""

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_pi import CONFIG, VARIANTS, config_txt, on_pi, reboots

pytestmark = pytest.mark.skipif(not on_pi(), reason="a Raspberry Pi build of fppinit")

# Where /proc/device-tree links to: the fake goes on the link's target, under
# the /sys the sandbox mounts before its fakes.
OVERRIDES = "/sys/firmware/devicetree/base/__overrides__"
BLOCK = ("# FPP WiFi Antenna - BEGIN (managed by fppinit, do not edit)\n"
         "[cm4]\ndtparam=ant2\n[cm5]\ndtparam=ant2\n[all]\n# FPP WiFi Antenna - END\n")


def test_the_external_antenna_setting_writes_one_block_on_a_compute_module(fppinit):
    """WifiAntenna=external on a module whose device tree has the ant2
    parameter adds one marked "dtparam=ant2" block, filtered to [cm4] and
    [cm5], ahead of the cape overlay variant block, without rebooting (the
    UI prompts); again changes nothing, and internal takes it out. A board
    without the parameter is left alone.

    Feature: 9677ccaf1. Before it there is no setupWifiAntenna action, and
    a module's U.FL socket could only be chosen by editing config.txt."""
    config_txt(fppinit, CONFIG)
    fppinit.settings(WifiAntenna="external")
    # The control: without the parameter (this board's own device tree),
    # config.txt is not touched.
    fppinit.run("setupWifiAntenna")
    assert config_txt(fppinit) == CONFIG, config_txt(fppinit)

    fppinit.fake_path(OVERRIDES, {"ant2": ""})
    fppinit.run("setupWifiAntenna")
    cfg = config_txt(fppinit)
    assert cfg.count("dtparam=ant2") == 2 and BLOCK in cfg, cfg
    assert cfg.index(BLOCK) < cfg.index(VARIANTS), cfg
    assert cfg.endswith(VARIANTS), cfg
    assert not reboots(fppinit), fppinit.calls()

    fppinit.run("setupWifiAntenna")
    assert config_txt(fppinit) == cfg, "a second run changed config.txt"

    fppinit.write("settings", 'WifiAntenna = "internal"\n')
    fppinit.run("setupWifiAntenna")
    assert "ant2" not in config_txt(fppinit), config_txt(fppinit)
    assert config_txt(fppinit).replace("\n", "") == CONFIG.replace("\n", ""), config_txt(fppinit)
