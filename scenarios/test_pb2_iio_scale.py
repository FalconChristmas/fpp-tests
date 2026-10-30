"""An IIO sensor source with no vScale on a PocketBeagle2: fppd scales its
readings by the ADC's own in_voltage_scale against the 1.8 V reference
(0.439453125 mV a count at 12 bits) the cape's sensor scales assume.

Once against an ADC served by fakeadc.c with the reference of the board's
real ADC (a K16-Pro's AD7291), once against that real ADC, reading
whatever its inputs measure. Device only: run-local.sh on a PocketBeagle2
(the default is PLATFORM_BB64's; elsewhere it is 1.0). Skipped elsewhere.
"""

import os

import pytest

import shims
from test_sensor_source_config import fake_iio_devices, iio
from test_sensor_sources import cape_sensors, reported, sensor

REF_1V8 = 0.439453125
REAL = "/sys/bus/iio/devices/iio:device0"


def on_pb2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not on_pb2(), reason="the default scale is a PocketBeagle2's")


def real_scale():
    try:
        with open(f"{REAL}/in_voltage_scale") as f:
            return float(f.read())
    except OSError:
        return None


def test_an_iio_source_without_vscale_is_scaled_to_its_adcs_reference(fppd):
    """1000 counts on an ADC whose in_voltage_scale is the board's (a 3.3 V
    reference here) report 1000 * scale / 0.439453125.

    Regression: 2382bf161 (the BB64 default). Readings were reported
    unscaled, so a cape's 1.8 V scales read 3.3 V inputs ~1.8x low."""
    scale = real_scale() or 0.805664062
    env = fake_iio_devices(fppd, {0: (1000,)})
    fppd.write("fakeiio0/sys/in_voltage_scale", f"{scale}\n")
    cape_sensors(fppd, [iio("adc", devId=0)], [sensor("A", "adc", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    got = reported(fppd)["A"]
    assert got == pytest.approx(1000 * scale / REF_1V8, rel=1e-3), got


def test_the_real_adcs_reading_is_scaled_the_same_way(fppd):
    """The board's own ADC, no vScale: a channel that measures something
    reads its raw count times in_voltage_scale / 0.439453125, within 5%
    (the input moves between the two reads)."""
    scale = real_scale()
    if scale is None:
        pytest.skip("no IIO ADC at iio:device0 here")
    raws = {}
    for ch in range(8):
        try:
            with open(f"{REAL}/in_voltage{ch}_raw") as f:
                raws[ch] = int(f.read())
        except OSError:
            pass
    live = [ch for ch, v in raws.items() if v > 100]
    if not live:
        pytest.skip(f"no ADC channel measures anything here: {raws}")
    ch = live[0]
    cape_sensors(fppd, [iio("adc", devId=0)], [sensor("A", "adc", ch)])
    fppd.start()
    got = reported(fppd)["A"]
    with open(f"{REAL}/in_voltage{ch}_raw") as f:
        after = int(f.read())
    want = (raws[ch] + after) / 2 * scale / REF_1V8
    assert got == pytest.approx(want, rel=0.05), (got, raws[ch], after, scale)
