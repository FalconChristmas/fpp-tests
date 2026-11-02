"""A multiplexer sensor source steps through its groups: each group's
sensors are read when the group's select pins are set, and every sensor
gets read. Setup as in test_sensor_reads.py; the select lines are the
TmpFile pins a container build has (TF-1, TF-2), high while
/tmp/GPIO-<pin> exists."""

import os

import pytest

import shims
from test_sensor_sources import cape_sensors, fake_iio, iio_source, reported, sensor


def test_a_multiplexer_reads_every_group_in_turn(fppd):
    """A mux of 4 groups of 2 channels over an ADC, 8 sensors on it: as
    status reports refresh it, its select pins count through all four
    combinations and every sensor, in every group, comes to report the
    ADC's reading.

    Feature: fc7f33950 (MuxSensorSource, muxing many analog signals onto
    fewer ADC channels). A source stuck on its first group would read just
    the first two sensors and leave the other six at zero.
    """
    env, _ = fake_iio(fppd, channels=2)
    mux = {"type": "mux", "id": "mux", "source": "iio", "channels": 2, "muxCount": 4,
           "muxPins": ["TF-1", "TF-2"]}
    cape_sensors(fppd, [iio_source(), mux], [sensor(f"M{i}", "mux", i) for i in range(8)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    if not reported(fppd):
        pytest.skip("the multiplexer's sensors aren't reported (no TmpFile pins in this build?)")
    groups, read = set(), set()
    for _ in range(80):
        for label, v in reported(fppd).items():
            if v == 1234.0:
                read.add(label)
        groups.add((os.path.exists("/tmp/GPIO-TF-1"), os.path.exists("/tmp/GPIO-TF-2")))
        if len(groups) == 4 and len(read) == 8:
            break
    assert len(groups) == 4, f"select pin states seen: {sorted(groups)}"
    assert read == {f"M{i}" for i in range(8)}, f"sensors read: {sorted(read)}"
