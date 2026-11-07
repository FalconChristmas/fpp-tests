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


def fake_iio(fppd, raw, trigger=None, buffered=(10, 20, 30, 40, 50, 600)):
    """iio:device0 with one channel: in_voltage0_raw reads raw; the buffer
    holds the given samples.  trigger, when not None, is the contents of
    trigger/current_trigger -- "" for a triggered buffer with no trigger
    assigned (ad799x and other I2C/SPI ADCs); None leaves out the trigger
    directory, as the Beagle's own ADC (ti_am335x_adc) does."""
    base = os.path.join(fppd.media, "fakeiio")
    fppd.write("fakeiio/sys/in_voltage0_raw", f"{raw}\n")
    fppd.write("fakeiio/sys/buffer/enable", "0\n")
    fppd.write("fakeiio/sys/buffer/length", "0\n")
    fppd.write("fakeiio/sys/scan_elements/in_voltage0_en", "0\n")
    if trigger is not None:
        fppd.write("fakeiio/sys/trigger/current_trigger", f"{trigger}\n")
    with open(os.path.join(base, "dev"), "wb") as f:
        f.write(struct.pack(f"<{len(buffered)}H", *buffered))
    return {"FAKEADC_MAP": f"/sys/bus/iio/devices/iio:device0={base}/sys;/dev/iio:device0={base}/dev"}


def test_an_iio_adc_whose_buffer_needs_a_trigger_is_read_through_sysfs(fppd):
    """An ADC with a triggered buffer and no trigger assigned (an AD7998
    through ad799x) can't have its buffer enabled, so with "useBuffers" left
    out the source reads in_voltage0_raw (123) rather than the buffer.

    Regression: 6452663a5.  Before it, buffer/enable existing was enough to pick the
    buffer, the kernel refused to enable it, and every channel read 0.
    """
    env = fake_iio(fppd, 123, trigger="", buffered=())
    cape_sensors(fppd, [{"type": "iio", "id": "iio", "devId": 0, "vScale": 1.0, "readIterations": 1}],
                 [sensor("A", "iio", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    fppd.wait_for(lambda: reported(fppd).get("A") == 123.0, timeout=10,
                  what=f"the channel's sysfs reading (reported {reported(fppd)})")


def test_an_iio_adc_without_a_trigger_directory_still_uses_its_buffer(fppd):
    """The Beagle's own ADC fills its buffer from its own timer and has no
    trigger directory: with "useBuffers" left out it is still read through
    the buffer (the trimmed mean 35), not through sysfs (999)."""
    env = fake_iio(fppd, 999)
    cape_sensors(fppd, [{"type": "iio", "id": "iio", "devId": 0, "vScale": 1.0}],
                 [sensor("A", "iio", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    fppd.wait_for(lambda: reported(fppd).get("A") == 35.0, timeout=10,
                  what=f"the trimmed mean of the buffered samples (reported {reported(fppd)})")


def test_an_iio_buffer_the_kernel_refuses_falls_back_to_sysfs(fppd):
    """"useBuffers": true, but writing 1 to buffer/enable fails with EINVAL,
    as the kernel answers for a triggered buffer with no trigger.  The source
    reads the channel through sysfs instead (123), and turns the channel
    back off in the buffer's scan elements.

    Regression: 6452663a5.  Before it, the failed write went unchecked and every
    channel read 0.
    """
    env = fake_iio(fppd, 123, buffered=())
    env["FAKEADC_REFUSE_WRITE"] = "/sys/bus/iio/devices/iio:device0/buffer/enable"
    cape_sensors(fppd, [{"type": "iio", "id": "iio", "devId": 0, "useBuffers": True,
                         "vScale": 1.0, "readIterations": 1}],
                 [sensor("A", "iio", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    fppd.wait_for(lambda: reported(fppd).get("A") == 123.0, timeout=10,
                  what=f"the channel's sysfs reading (reported {reported(fppd)})")
    with open(os.path.join(fppd.media, "fakeiio/sys/scan_elements/in_voltage0_en")) as f:
        assert f.read().strip() == "0"
