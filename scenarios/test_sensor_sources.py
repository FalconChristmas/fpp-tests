"""Sensor sources from a cape's sensor config (media/tmp/cape-sensors.json):
an IIO ADC, an ADS7828 on I2C and a multiplexer over a source, served by
fakeadc.c so they run with no hardware."""

import os

import shims

BUS = 7


def fake_iio(fppd, channels=2, value="1234"):
    """An IIO ADC, iio:device0, with `channels` raw voltage inputs, served
    from the media directory. Returns (environment, raw file of channel 0)."""
    base = os.path.join(fppd.media, "fakeiio")
    for ch in range(channels):
        fppd.write(f"fakeiio/sys/in_voltage{ch}_raw", value + "\n")
    fppd.write("fakeiio/dev", "")
    env = {"FAKEADC_MAP": f"/sys/bus/iio/devices/iio:device0={base}/sys;/dev/iio:device0={base}/dev"}
    return env, os.path.join(base, "sys", "in_voltage0_raw")


def iio_source():
    return {"type": "iio", "id": "iio", "devId": 0, "useBuffers": False, "vScale": 1.0}


def sensor(label, source, channel):
    return {"type": "sensor", "label": label, "sensor": source, "channel": channel,
            "valueType": "Current"}


def cape_sensors(fppd, sources, sensors):
    fppd.write("tmp/cape-sensors.json", {"sensorSources": sources, "sensors": sensors})


def reported(fppd):
    return {s["label"]: s["value"] for s in fppd.get("/fppd/status").get("sensors", [])
            if s.get("valueType") == "Current"}


def fds_on(pid, path):
    n = 0
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            if os.readlink(f"/proc/{pid}/fd/{fd}") == path:
                n += 1
        except OSError:
            pass
    return n


def test_iio_channel_shared_by_several_sensors_is_opened_once(fppd):
    """Five sensors on channel 0 of one IIO ADC hold one descriptor on its
    raw file between them, and all report its reading.

    Regression: d9477932e. enable() opened the raw file on every call and
    overwrote the descriptor it already had. It runs once per consumer --
    every current-monitored port, again on each output reload, and once a
    port through a multiplexer -- so a board with current sensing leaked
    descriptors until fppd ran out of them.
    """
    env, raw = fake_iio(fppd)
    cape_sensors(fppd, [iio_source()], [sensor(f"P{i}", "iio", 0) for i in range(5)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values == {f"P{i}": 1234.0 for i in range(5)}, values
    assert fds_on(fppd.proc.pid, raw) == 1, \
        f"{fds_on(fppd.proc.pid, raw)} descriptors open on one IIO channel"


def test_a_failing_ads7828_read_holds_the_last_value(fppd):
    """An ADS7828 that answers two block reads (one sample) and then fails
    every transfer: fppd keeps answering its status, reporting the last
    good reading, poll after poll.

    Regression: 188a165e0. readI2CBlockData() returns -1 on a failed
    transfer, and the read loop added it to its byte count: the count went
    negative, the next read indexed before the 8-byte stack buffer and
    asked for more than it holds, and the loop never ended (an ASan
    stack-buffer-overflow here; in the field, a SIGBUS through a pointer
    the overrun had written ADC data into).
    """
    cape_sensors(fppd, [{"type": "ads7828", "id": "adc", "i2cBus": BUS, "i2cAddress": "0x48"}],
                 [sensor("ADC", "adc", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")],
               extra_env={"FAKEADC_I2C_BUS": str(BUS), "FAKEADC_GOOD_READS": "2"})
    first = reported(fppd)
    assert first == {"ADC": float(0x123)}, f"the one good sample: {first}"
    for _ in range(5):
        assert reported(fppd) == first


def test_bad_multiplexer_sources_are_dropped(fppd):
    """Multiplexer sources fppd can't use -- no channels, a select pin that
    doesn't exist, a source that doesn't exist -- are each dropped with a
    log line saying why, and fppd starts and reports its sensors.

    Regression: a31b12730. An unknown pin name was looked up as the null
    pin and configured through its null pointer at startup (SIGSEGV), and
    channels or a mux count of 0 divided by zero on every read.
    """
    env, _ = fake_iio(fppd, channels=4)
    mux = {"type": "mux", "source": "iio", "channels": 2, "muxCount": 2, "muxPins": []}
    cape_sensors(fppd, [
        iio_source(),
        dict(mux, id="none", channels=0, muxCount=0),
        dict(mux, id="nopin", muxPins=["NO_SUCH_PIN"]),
        dict(mux, id="nosource", source="nothing"),
    ], [sensor("direct", "iio", 1)] + [sensor(m, m, 1) for m in ("none", "nopin", "nosource")])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values.get("direct") == 1234.0, values
    log = fppd.log()
    assert "has invalid channels (0) or muxCount (0)" in log
    assert "references unknown pin 'NO_SUCH_PIN'" in log
    assert "references unknown source 'nothing'" in log
