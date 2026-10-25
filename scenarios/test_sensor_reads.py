"""Reading sensor sources from a cape's sensor config: an IIO ADC whose
reads fail or are averaged over no reads, and a multiplexer polled by two
clients at once. fakeadc.c serves the ADC; the multiplexer's select lines
are the TmpFile pins a container build has (TF-1, TF-2), so these run in
Docker. The race shows under TSan (run.sh --flavor tsan): a TSan report
fails the scenario.
"""

import os
import threading

import pytest

import shims
from test_sensor_sources import cape_sensors, fake_iio, iio_source, reported, sensor


def test_an_iio_source_set_to_average_no_reads_reads_once(fppd):
    """An IIO source with readIterations 0 still reports its channel's
    reading.

    Regression: 4386883ca. update() averaged over readIterations reads by
    dividing by it: 0 reads summed to 0, divided by 0, NaN, which the
    integer conversion turned into a meaningless value (0 on arm64,
    INT_MIN on x86). It is kept to 1-100 now.
    """
    env, _ = fake_iio(fppd)
    cape_sensors(fppd, [dict(iio_source(), readIterations=0)], [sensor("A", "iio", 0)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    values = reported(fppd)
    assert values == {"A": 1234.0}, values


def test_an_iio_channel_whose_read_fails_reads_zero(fppd):
    """An IIO channel whose raw file can't be read (here a directory: the
    open succeeds, every read fails) reports 0; the other channel still
    reports its reading, and fppd keeps answering.

    Regression: 4386883ca. The read's -1 was used as the length of what was
    read: buf[-1] = 0 wrote one byte before the stack buffer (an ASan
    stack-buffer-underflow).
    """
    env, _ = fake_iio(fppd, channels=1)
    os.makedirs(os.path.join(fppd.media, "fakeiio", "sys", "in_voltage1_raw"))
    cape_sensors(fppd, [iio_source()], [sensor("good", "iio", 0), sensor("bad", "iio", 1)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    for _ in range(5):
        values = reported(fppd)
        assert values == {"good": 1234.0, "bad": 0.0}, values
    fppd.check_alive()


def test_a_multiplexer_polled_by_two_clients_at_once(fppd):
    """Two clients reading /api/fppd/status at once, over and over, each
    report refreshing a multiplexer's readings and moving it on to its next
    group: no data race (TSan), and every reading is the ADC's.

    Regression: 4386883ca. MuxSensorSource had no lock: update(), which
    advances the mux and moves its select pins, and getValue() ran on every
    HTTP thread that built a status report, all walking and writing the
    same vectors.
    """
    env, _ = fake_iio(fppd, channels=2)
    mux = {"type": "mux", "id": "mux", "source": "iio", "channels": 2, "muxCount": 4,
           "muxPins": ["TF-1", "TF-2"]}
    cape_sensors(fppd, [iio_source(), mux], [sensor(f"M{i}", "mux", i) for i in range(8)])
    fppd.start(preload=[shims.build("fakeadc.c")], extra_env=env)
    if not reported(fppd):
        pytest.skip("the multiplexer's sensors aren't reported (no TmpFile pins in this build?)")
    bad = []

    def poll():
        for _ in range(150):
            values = reported(fppd)
            bad.extend(v for v in values.values() if v not in (0.0, 1234.0))

    threads = [threading.Thread(target=poll) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    fppd.check_alive()
    assert not bad, bad[:10]
