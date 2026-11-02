"""An IIO ADC read through its sample buffer (media/tmp/cape-sensors.json,
"useBuffers": true), served by fakeadc.c so it runs with no hardware.
"""

import os
import struct

import shims
from test_sensor_sources import cape_sensors, reported, sensor


def test_a_buffered_iio_source_drops_its_highest_and_lowest_samples(fppd):
    """Six samples of channel 0 in the ADC's buffer, 10 20 30 40 50 and a
    stray 600: with more than three samples the source reports their mean
    without the highest and the lowest, (20+30+40+50)/4 = 35, not the plain
    mean of 125.

    Regression: 5be13914a, which added the IIO source: the Beagle's ADC
    samples several times a read and the cape's noise (an odd reading a few
    hundred counts out) is cut out before it reaches the current display.
    """
    base = os.path.join(fppd.media, "fakeiio")
    fppd.write("fakeiio/sys/in_voltage0_raw", "0\n")
    fppd.write("fakeiio/sys/buffer/enable", "0\n")
    fppd.write("fakeiio/sys/buffer/length", "0\n")
    fppd.write("fakeiio/sys/scan_elements/in_voltage0_en", "1\n")
    with open(os.path.join(base, "dev"), "wb") as f:
        f.write(struct.pack("<6H", 10, 20, 30, 40, 50, 600))
    env = {"FAKEADC_MAP": f"/sys/bus/iio/devices/iio:device0={base}/sys;/dev/iio:device0={base}/dev"}
    cape_sensors(fppd, [{"type": "iio", "id": "iio", "devId": 0, "useBuffers": True, "vScale": 1.0}],
                 [sensor("A", "iio", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    fppd.wait_for(lambda: reported(fppd).get("A") == 35.0, timeout=10,
                  what=f"the trimmed mean of the buffered samples (reported {reported(fppd)})")
