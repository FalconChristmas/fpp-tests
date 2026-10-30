"""Sensor source options in a cape's sensor config (media/tmp/cape-sensors.json):
an IIO ADC found by its I2C bus and address rather than its device number,
its voltage scale, and a "multi" source that joins several sources into one
channel range. fakeadc.c serves the ADCs' sysfs and device files from the
media directory, so these run with no hardware.
"""

import os

import shims
from test_sensor_sources import cape_sensors, reported, sensor


def fake_iio_devices(fppd, devices, extra_maps=()):
    """IIO ADCs iio:deviceN, each {N: (channel 0's raw value, ...)}, served
    from the media directory. `extra_maps` are more "<from>=<to>" pairs for
    FAKEADC_MAP. Returns the environment."""
    maps = list(extra_maps)
    for n, values in devices.items():
        base = os.path.join(fppd.media, f"fakeiio{n}")
        for ch, value in enumerate(values):
            fppd.write(f"fakeiio{n}/sys/in_voltage{ch}_raw", f"{value}\n")
        fppd.write(f"fakeiio{n}/dev", "")
        maps += [f"/sys/bus/iio/devices/iio:device{n}={base}/sys", f"/dev/iio:device{n}={base}/dev"]
    return {"FAKEADC_MAP": ";".join(maps)}


def iio(id, **kv):
    return dict({"type": "iio", "id": id, "useBuffers": False}, **kv)


def test_an_iio_source_is_found_by_its_i2c_bus_and_address(fppd):
    """An IIO source configured with i2cBus and i2cDev instead of devId
    reads the IIO device the kernel bound under that I2C address
    (/sys/class/i2c-dev/i2c-<bus>/device/<bus>-00<addr>/iio:device<N>),
    whatever N the device got this boot: here iio:device3, while
    iio:device0 is another ADC reading something else.

    Regression: d13ab3cb4. Without devId the source always read
    iio:device0, and IIO device numbers follow probe order, which can
    change from boot to boot.
    """
    i2cdir = os.path.join(fppd.media, "fakei2c")
    fppd.write("fakei2c/2-0048/iio:device3/name", "ads1015\n")
    env = fake_iio_devices(fppd, {0: (111, 111), 3: (3333, 3333)},
                           extra_maps=[f"/sys/class/i2c-dev/i2c-2/device={i2cdir}"])
    cape_sensors(fppd, [iio("adc", i2cBus=2, i2cDev=0x48, vScale=1.0)], [sensor("A", "adc", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values == {"A": 3333.0}, values


def test_an_iio_sources_vscale_scales_its_readings(fppd):
    """An IIO source's vScale multiplies every reading: 1234 raw with
    vScale 2 reports 2468, beside an unscaled source on another ADC.

    Regression: 2382bf161 (the vScale setting; the BB64 default scale,
    derived from in_voltage_scale when vScale is absent, is built only for
    a PocketBeagle2 and not covered here). The raw value was reported as
    read whatever the config said.
    """
    env = fake_iio_devices(fppd, {0: (1234,), 1: (1234,)})
    cape_sensors(fppd, [iio("scaled", devId=0, vScale=2.0), iio("plain", devId=1, vScale=1.0)],
                 [sensor("S", "scaled", 0), sensor("P", "plain", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values == {"S": 2468.0, "P": 1234.0}, values


def test_a_multi_source_joins_its_sources_channels_in_order(fppd):
    """A "multi" source over two IIO ADCs of two channels each numbers
    their channels one after the other: channels 0-1 are the first ADC's,
    2-3 the second's, so one multiplexer line can feed several sources.

    Regression: 4dae8d8ef, which added the "multi" source type; before it
    the source was unknown and every sensor on it read 0.
    """
    env = fake_iio_devices(fppd, {0: (100, 101), 1: (200, 201)})
    multi = {"type": "multi", "id": "multi",
             "sources": [{"source": "a", "channels": 2}, {"source": "b", "channels": 2}]}
    cape_sensors(fppd, [iio("a", devId=0, vScale=1.0), iio("b", devId=1, vScale=1.0), multi],
                 [sensor(f"M{i}", "multi", i) for i in range(4)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values == {"M0": 100.0, "M1": 101.0, "M2": 200.0, "M3": 201.0}, values
