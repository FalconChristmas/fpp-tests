"""Fan speed sensors: which hwmon fans fppd shows an RPM for.

Runs anywhere, Docker included: fakesys.c serves /sys/class/hwmon from the
media directory, and the boot-time fan probe's answer (media
tmp/fan_probe.json, written by fppinit; see test_fppinit_pi_boot.py) is
planted as fppinit leaves it.
"""

import os

import shims


def fans(fppd):
    return [s for s in fppd.get("/fppd/status").get("sensors", []) if s.get("valueType") == "FanSpeed"]


def test_a_fan_with_no_tach_signal_at_boot_shows_no_rpm(fppd):
    """Two fan nodes, a pwm-fan reading 0 RPM that the boot probe found
    absent and a gpio-fan at 5000 RPM that it found present: fppd shows an
    RPM for the gpio-fan only.

    Regression: ef27ebc64 (fppd's half). A pwm-fan node always has
    fan1_input, so with no fan on the tach pin the status page showed a fan
    stalled at 0 RPM.
    """
    for rel, text in (("hwmon0/name", "pwmfan"), ("hwmon0/fan1_input", "0"),
                      ("hwmon1/name", "gpio_fan"), ("hwmon1/fan1_input", "5000")):
        fppd.write(f"fakesys/hwmon/{rel}", text + "\n")
    fppd.write("tmp/fan_probe.json", {"pwmfan:1": {"present": False, "rpm": 0},
                                      "gpio_fan:1": {"present": True, "rpm": 5000}})
    base = os.path.join(fppd.media, "fakesys", "hwmon")
    fppd.start(preload=[shims.build("fakesys.c")], extra_env={"FAKESYS": f"/sys/class/hwmon={base}"})
    shown = fans(fppd)
    # The control: the present fan is there, so the fake nodes were read.
    assert [s["label"] for s in shown] == ["gpio_fan: "], shown
    assert shown[0]["value"] == 5000, shown
