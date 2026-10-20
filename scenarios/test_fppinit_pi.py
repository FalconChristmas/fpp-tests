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


VARIANTS = ("# FPP Cape Overlay Variants - BEGIN (managed by fppcapedetect, do not edit)\n"
            "[pi5]\ndtoverlay=fpp-cape-overlay-pi5\n[all]\n# FPP Cape Overlay Variants - END\n")
CONFIG = "[all]\ndtparam=audio=on\n\n" + VARIANTS


def config_txt(sb, content=None):
    path = os.path.join(sb.boot, "config.txt")
    if content is not None:
        with open(path, "w") as f:
            f.write(content)
    with open(path) as f:
        return f.read()


def reboots(sb):
    return [c for c in sb.calls() if "reboot" in c]


def test_the_pi_rtc_setting_writes_one_block_ahead_of_the_cape_variants(fppinit):
    """DisablePiRTC=1 adds one marked block -- "[pi5]", "dtparam=rtc=off",
    closed by "[all]" -- ahead of the cape overlay variant block, without
    rebooting (the UI prompts); running again changes nothing, and 0 takes
    the block out, leaving config.txt as it was.

    Feature: 02485a93b. The block goes in place, ahead of the variant
    block, because that one is stripped and re-appended at the end: two
    blocks that both append leapfrog, and each boot sees a changed file and
    reboots.
    """
    config_txt(fppinit, CONFIG)
    fppinit.settings(DisablePiRTC=1)
    fppinit.run("setupPiRTC")
    cfg = config_txt(fppinit)
    block = ("# FPP Pi RTC - BEGIN (managed by fppinit, do not edit)\n[pi5]\ndtparam=rtc=off\n"
             "[all]\n# FPP Pi RTC - END\n")
    assert cfg.count("dtparam=rtc=off") == 1, cfg
    assert block in cfg, cfg
    assert cfg.index(block) < cfg.index(VARIANTS), cfg
    assert cfg.endswith(VARIANTS), cfg
    assert not reboots(fppinit), fppinit.calls()

    fppinit.run("setupPiRTC")
    assert config_txt(fppinit) == cfg, "a second run changed config.txt"

    fppinit.write("settings", 'DisablePiRTC = "0"\n')
    fppinit.run("setupPiRTC")
    assert "rtc=off" not in config_txt(fppinit), config_txt(fppinit)
    assert config_txt(fppinit).replace("\n", "") == CONFIG.replace("\n", ""), config_txt(fppinit)


def is_pi5():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().startswith(("Raspberry Pi 5", "Raspberry Pi Compute Module 5"))
    except OSError:
        return False


CEC_BLOCK = ("# FPP HDMI CEC - BEGIN (managed by fppinit, do not edit)\n[all]\n"
             "hdmi_ignore_cec_init=1\n[all]\n# FPP HDMI CEC - END\n")


def test_the_hdmi_cec_setting_writes_one_block_where_the_firmware_reads_it(fppinit):
    """DisableHDMICECInit=1 adds one marked "hdmi_ignore_cec_init=1" block
    ahead of the cape overlay variant block on a Pi with a firmware HDMI
    path, without rebooting; again is a no-op, and 0 removes it. On a Pi 5
    (KMS over RP1, where the line does nothing) the block is never written,
    and one left from before is taken out.

    Regression: e984f69e6 (setupHDMICEC, so a TV or projector on HDMI is
    not woken by the boot's CEC broadcast). Run on a Pi 4 and a Pi 5 to
    cover both halves.
    """
    if is_pi5():
        config_txt(fppinit, "[all]\ndtparam=audio=on\n\n" + CEC_BLOCK + "\n" + VARIANTS)
        fppinit.settings(DisableHDMICECInit=1)
        fppinit.run("setupHDMICEC")
        cfg = config_txt(fppinit)
        assert "hdmi_ignore_cec_init" not in cfg and "HDMI CEC" not in cfg, cfg
        assert cfg.endswith(VARIANTS), cfg
        assert not reboots(fppinit), fppinit.calls()
        return

    config_txt(fppinit, CONFIG)
    fppinit.settings(DisableHDMICECInit=1)
    fppinit.run("setupHDMICEC")
    cfg = config_txt(fppinit)
    assert cfg.count("hdmi_ignore_cec_init=1") == 1 and CEC_BLOCK in cfg, cfg
    assert cfg.index(CEC_BLOCK) < cfg.index(VARIANTS), cfg
    assert not reboots(fppinit), fppinit.calls()

    fppinit.run("setupHDMICEC")
    assert config_txt(fppinit) == cfg, "a second run changed config.txt"

    fppinit.write("settings", 'DisableHDMICECInit = "0"\n')
    fppinit.run("setupHDMICEC")
    assert "hdmi_ignore_cec_init" not in config_txt(fppinit), config_txt(fppinit)
