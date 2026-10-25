"""fppinit boot steps on a Raspberry Pi that depend on the board: its memory,
its fan, its GPIO lines. In the fppinit sandbox, with the board's /proc and
/sys files faked where the scenario needs another board.

Device only: run with run-local.sh on a Pi (a Pi build of fppinit).
"""

import os

import pytest

from fppinit import fppinit  # noqa: F401 -- the fixture
from test_fppinit_pi import config_txt, on_pi, reboots

pytestmark = pytest.mark.skipif(not on_pi(), reason="a Raspberry Pi build of fppinit")


def meminfo(total_kb):
    return (f"MemTotal:       {total_kb} kB\nMemFree:        {total_kb // 2} kB\n"
            f"MemAvailable:   {total_kb // 2} kB\n")


KMS = "dtoverlay=vc4-kms-v3d,cma-256\n"
CONFIG = "[all]\ndtparam=audio=on\n" + KMS + "max_framebuffers=2\n"


@pytest.mark.parametrize("total_kb,expect", [(427000, "cma-128"), (3990000, "cma-256")],
                         ids=["512MB-board", "4GB-board"])
def test_a_512mb_board_gets_a_smaller_kms_cma_pool(fppinit, total_kb, expect):
    """config.txt loads vc4-kms-v3d with cma-256, as the image ships it:
    on a board with about 512MB (MemTotal 427000 kB) setupChannelOutputs
    rewrites the line to cma-128, once -- a second run changes nothing --
    while on a 4GB board it is left as it is.

    Regression: 5c834077d. Every Pi kept cma-256, which the overlay
    documents as needing 1GB and the firmware does not clamp: a 512MB Pi
    Zero 2 W gave half its memory to the GPU pool.
    """
    config_txt(fppinit, CONFIG)
    fppinit.fake_path("/proc/meminfo", meminfo(total_kb))
    fppinit.run("setupChannelOutputs")
    cfg = config_txt(fppinit)
    assert f"dtoverlay=vc4-kms-v3d,{expect}\n" in cfg, cfg
    assert cfg.count("dtoverlay=vc4-kms-v3d") == 1, cfg
    fppinit.run("setupChannelOutputs")
    assert config_txt(fppinit) == cfg, "a second run changed config.txt again"


def hwmon(fan_rpm):
    """/sys/class/hwmon with one pwm-fan node whose tachometer reads
    fan_rpm, and a CPU temperature node with no fan."""
    return {"hwmon0/name": "cpu_thermal\n", "hwmon0/temp1_input": "45000\n",
            "hwmon1/name": "pwmfan\n", "hwmon1/fan1_input": f"{fan_rpm}\n",
            "hwmon1/pwm1": "0\n", "hwmon1/pwm1_enable": "2\n"}


@pytest.mark.parametrize("rpm,present", [(0, False), (4387, True)], ids=["no-fan", "fan"])
def test_the_boot_probe_records_whether_a_fan_answers_on_its_tach(fppinit, rpm, present):
    """A pwm-fan node whose tachometer reads 0 RPM with the fan forced on
    is recorded as absent in media tmp/fan_probe.json by the boot's start
    step, and one that reads 4387 as present.

    Regression: ef27ebc64 (its boot half; test_fan_sensors.py has fppd's).
    A pwm-fan node always has fan1_input, so a board with no fan on the
    tach pin showed a fan stalled at 0 RPM.
    """
    fppinit.fake_path("/sys/class/hwmon", hwmon(rpm))
    fppinit.run("start")
    import json
    probe = json.loads(fppinit.media_file("tmp/fan_probe.json"))
    assert probe.get("pwmfan:1", {}).get("present") is present, probe
    assert "cpu_thermal:1" not in probe, probe


REBOOT_GPIO = 27  # P1-13, free on the header unless a cape uses it


def test_a_cape_reboot_action_drives_its_named_gpio_line(fppinit):
    """A cape whose cape-info lists a reboot action "+GPIO27": the reboot
    step drives the line named GPIO27 high (pinctrl reads the pad back as
    an output driving high), finding it by name through libgpiod, and
    returns.

    Regression: f2940375e. The step parsed `gpioinfo` and ran `gpioset
    <chip> <line>=<value>`, libgpiod 1.x's syntax. Debian 13 has libgpiod
    2.x, whose gpioset takes no chip that way and holds the line until it
    is killed: the reboot action never set the pin, and the step hung.

    Needs a Pi whose GPIO27 is free; it drives the real pad, and puts it
    back as it was afterwards.
    """
    import hosttools
    import glob
    fppinit.write("tmp/cape-info.json", {"id": "TestCape", "name": "Test Cape",
                                         "rebootActions": [{"type": "gpio", "pin": f"+GPIO{REBOOT_GPIO}"}]})
    for chip in glob.glob("/dev/gpiochip*"):
        fppinit.device(os.path.basename(chip))
    with hosttools.pads_kept([REBOOT_GPIO]):
        before = hosttools.pad_states([REBOOT_GPIO])[REBOOT_GPIO]
        if before and before.split()[0] not in ("no", "ip"):
            pytest.skip(f"GPIO{REBOOT_GPIO} is in use here ({before})")
        fppinit.run("reboot", timeout=30)
        after = hosttools.pad_states([REBOOT_GPIO])[REBOOT_GPIO]
        assert after and after.split()[:2] == ["op", "dh"], \
            f"GPIO{REBOOT_GPIO} is {after!r} after the reboot action, not an output driving high"
