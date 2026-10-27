"""Fan speed sensors: which hwmon fans fppd shows an RPM for.

Runs anywhere, Docker included: fakesys.c serves /sys/class/hwmon from the
media directory, and the boot-time fan probe's answer (media
tmp/fan_probe.json, written by fppinit; see test_fppinit_pi_boot.py) is
planted as fppinit leaves it.
"""

import os
import re

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


def start_with_hwmon(fppd, files):
    """fppd with a fake /sys/class/hwmon holding `files` ({relative path:
    contents}) and no boot-time fan probe (every fan "unknown")."""
    for rel, text in files.items():
        fppd.write(f"fakesys/hwmon/{rel}", text)
    base = os.path.join(fppd.media, "fakesys", "hwmon")
    fppd.start(preload=[shims.build("fakesys.c")], extra_env={"FAKESYS": f"/sys/class/hwmon={base}"})


def test_a_hwmon_fan_is_shown_in_rpm(fppd):
    """A hwmon node with a fan1_input reading 2345: fppd's status lists a
    FanSpeed sensor reading 2345 (RPM), which System Stats shows.

    Feature: 1fa7d12ff (fan monitoring). Before it fppd listed no fan at
    all, whatever hwmon offered."""
    start_with_hwmon(fppd, {"hwmon0/name": "pwmfan\n", "hwmon0/fan1_input": "2345\n"})
    shown = fans(fppd)
    assert len(shown) == 1, shown
    assert shown[0]["value"] == 2345, shown
    assert shown[0].get("postfix") == " RPM", shown


def test_a_fans_label_comes_from_the_device_tree_where_it_can(fppd):
    """Three pwm-fan hwmon nodes, one fan each: one whose device-tree node
    carries an fpp,fan-label ("K16-Pro Fan"), one whose node is named
    cooling_fan (as a Pi 5's is), and one with only the generic pwm-fan
    node name. Their labels are "K16-Pro Fan", "Cooling Fan" and "pwmfan"
    -- no " Fan" added to a name already ending in one -- each followed by
    ": " (and, at 2f34000a4 itself, the fan's index).

    Regression: 2f34000a4. Every fan was labelled from its hwmon name,
    "pwmfan Fan 1", so two fans read the same and a cape's own name for
    its fan was never used. Device-tree strings end in a NUL, as here."""
    start_with_hwmon(fppd, {
        "hwmon0/name": "pwmfan\n", "hwmon0/fan1_input": "1000\n", "hwmon0/of_node/fpp,fan-label": "K16-Pro Fan\0",
        "hwmon1/name": "pwmfan\n", "hwmon1/fan1_input": "2000\n", "hwmon1/of_node/name": "cooling_fan\0",
        "hwmon2/name": "pwmfan\n", "hwmon2/fan1_input": "3000\n", "hwmon2/of_node/name": "pwm-fan\0"})
    labels = {s["value"]: re.sub(r" 1: $", ": ", s["label"]) for s in fans(fppd)}
    assert labels == {1000: "K16-Pro Fan: ", 2000: "Cooling Fan: ", 3000: "pwmfan: "}, labels


def test_a_fans_index_is_shown_only_beside_another_fan(fppd):
    """A pwm-fan hwmon node with one fan and a gpio_fan node with two: the
    single fan is "pwmfan: ", the pair "gpio_fan 1: " and "gpio_fan 2: ".

    Regression: f5a1df364 (its Sensors.cpp half). Every fan's label ended
    in its index, so a board's only fan read "pwmfan 1"."""
    start_with_hwmon(fppd, {
        "hwmon0/name": "pwmfan\n", "hwmon0/fan1_input": "1000\n",
        "hwmon1/name": "gpio_fan\n", "hwmon1/fan1_input": "2000\n", "hwmon1/fan2_input": "3000\n"})
    labels = {s["value"]: s["label"] for s in fans(fppd)}
    assert labels == {1000: "pwmfan: ", 2000: "gpio_fan 1: ", 3000: "gpio_fan 2: "}, labels
