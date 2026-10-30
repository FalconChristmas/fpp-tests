"""Sensors: what fppd reads from config/sensors.json and from /sys at startup.

The I2C sensor probes its chip with an i2cdetect shell command built from the
config's address, and the hardware scan names each thermal zone from its
/sys/class/thermal type file. Neither has the hardware here, so the scenarios
stand in for it: a fake i2cdetect on fppd's PATH that logs how it was called,
and fakesys.c, which serves /sys/class/thermal from the media directory.
"""

import os
import stat

import shims


def fake_i2cdetect(fppd):
    """An i2cdetect ahead of any real one on fppd's PATH. It logs its
    arguments, one call a line, and answers "--" (no chip at the address),
    so the sensor doesn't go on to bind a driver or read the bus."""
    bindir = os.path.join(fppd.media, "bin")
    log = os.path.join(fppd.media, "tmp", "i2cdetect.log")
    path = fppd.write("bin/i2cdetect", "#!/bin/sh\n"
                      f'echo "$*" >> {log}\n'
                      'echo "40: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- --"\n')
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    env = {"PATH": bindir + ":" + os.environ.get("PATH", "/usr/bin:/bin")}
    return env, log


def i2c_sensor(address):
    return {"sensors": [{"type": "i2c", "label": "T", "driver": "lm75",
                         "path": "/nonexistent/temp", "address": address}]}


def test_an_i2c_sensor_address_never_reaches_the_shell(fppd):
    """An I2C sensor's address is checked before it goes into the i2cdetect
    command line, so sensors.json can't run a command. A plain address still
    probes the chip, which shows the probe really runs here.

    Regression: cedbfa7bc. The address was pasted unquoted into the
    popen()'d command, and "0x48;touch <file>;#" ran touch at startup.
    """
    env, log = fake_i2cdetect(fppd)
    pwned = os.path.join(fppd.media, "tmp", "pwned")
    fppd.write("config/sensors.json", i2c_sensor(f"0x48;touch {pwned};#"))
    fppd.start(extra_env=env)
    assert not os.path.exists(pwned), "the sensor address ran a shell command"
    calls = open(log).read().splitlines() if os.path.exists(log) else []
    assert not any("touch" in c or ";" in c for c in calls), calls
    fppd.get("/fppd/status")


def test_a_valid_i2c_sensor_address_is_probed(fppd):
    """The control for the case above: with a plain address the sensor runs
    i2cdetect for it, so a missing probe can't make the case above pass."""
    env, log = fake_i2cdetect(fppd)
    fppd.write("config/sensors.json", i2c_sensor("0x48"))
    fppd.start(extra_env=env)
    calls = open(log).read().splitlines() if os.path.exists(log) else []
    assert calls and all(c.endswith(" 0x48 0x48") for c in calls), calls


def thermal_zone(fppd, ztype, temp="42000"):
    """Start fppd with one thermal zone, of type `ztype`, in place of the
    host's, and return its sensors."""
    base = os.path.join(fppd.media, "fakesys", "thermal")
    fppd.write("fakesys/thermal/thermal_zone0/temp", temp + "\n")
    fppd.write("fakesys/thermal/thermal_zone0/type", ztype)
    fppd.start(preload=[shims.build("fakesys.c")],
               extra_env={"FAKESYS": f"/sys/class/thermal={base}"})
    return [s for s in fppd.get("/fppd/status").get("sensors", [])
            if s.get("valueType") == "Temperature"]


def test_a_thermal_zone_named_just_thermal_zone(fppd):
    """A zone whose type is exactly "thermal_zone" -- nothing in front of the
    suffix to strip it from -- is named after the whole type.

    Regression: 1dcfae7b9. The suffix strip wrote path[r - 13], one byte
    before the stack buffer, for a 12-character type: an ASan
    stack-buffer-overflow report at startup.
    """
    sensors = thermal_zone(fppd, "thermal_zone\n")
    # Only the fake zone is there, so the shim engaged: a host zone would
    # carry its own name, and no zone at all means it didn't.
    assert [s["label"] for s in sensors] == ["THERMAL_ZONE: "], sensors
    assert abs(sensors[0]["value"] - 42.0) < 0.01, sensors


def test_a_thermal_zone_type_with_a_dashed_suffix(fppd):
    """A zone of type "soc-thermal-zone" is labelled "SOC: ", like one of
    type "soc_thermal_zone".

    Regression: 7ba68c973. 1dcfae7b9's bounds check dropped the
    "thermal-zone" spelling, so the label kept the whole suffix:
    "SOC-THERMAL-ZONE: ".
    """
    sensors = thermal_zone(fppd, "soc-thermal-zone\n")
    assert [s["label"] for s in sensors] == ["SOC: "], sensors
    assert abs(sensors[0]["value"] - 42.0) < 0.01, sensors


def test_a_thermal_zone_named_in_the_device_tree_keeps_its_case(fppd):
    """A zone whose type has capitals in it -- a name a device tree gave it,
    "PMIC-Temp" -- keeps that name as written, dashes and all; an all
    lower-case type is still upper-cased, its "-thermal" suffix dropped
    ("cpu-thermal" is "CPU", the rest of the file's cases).

    Regression: 94a565e87. Every type was upper-cased and cut at its
    first dash, so the device tree's name came out as "PMIC".
    """
    sensors = thermal_zone(fppd, "PMIC-Temp\n")
    assert [s["label"] for s in sensors] == ["PMIC-Temp: "], sensors
