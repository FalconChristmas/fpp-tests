"""The AES67 sender's rate-trim loop (adaptiveResample, off by default): a
"pitch" element in the send pipeline, trimmed from the stream's own measured
rate against the media clock.

It needs 60 s of measurement before its first reading and then corrects every
30 s, so these take a while.
"""

import re
import time

import pytest

from fppd import sanitizer
from rtp_capture import RtpCapture, discontinuities
from test_aes67_wire import start_sender, window

# As for test_aes67_wire.py: a live stream under TSan says nothing about races
# and doesn't keep time.
pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="timing scenarios; see test_aes67_wire.py")

READING = re.compile(r"AES67 drift \[1\]: over (\d+)s media/PTP ([0-9.]+) \(([+-][0-9.]+) ppm\), "
                     r"lag ([+-][0-9.]+) ms, trim ([+-][0-9.]+) ppm")


def readings(fppd):
    return [tuple(map(float, m)) for m in READING.findall(fppd.log())]


def test_the_trim_loop_measures_the_stream_and_leaves_it_whole(fppd, audio):
    """A stereo sender with the trim on: the loop starts, reports a reading
    of its stream over at least the minute of baseline it needs, with the
    stream's rate about the clock's and a trim that took only one 20 ppm step.
    The stream stays stereo at one packet per millisecond throughout, with the
    trim's element in the pipeline.
    """
    fppd.settings(LogLevel_MediaOut="debug")
    with RtpCapture(5004) as cap:
        # driftResample off: with it on as well, the pipeline text has two
        # caps filters in a row, which gst_parse_launch() refuses, so the
        # sender never starts.
        start_sender(fppd, audio, adaptiveResample=True, driftResample=False)
        assert "AES67 drift control thread started" in fppd.log()
        fppd.wait_for(lambda: readings(fppd), timeout=180, interval=2, what="the loop's first reading")
        pk = window(cap, 3)
    span, ratio, ppm, lag_ms, trim = readings(fppd)[0]
    assert 60 <= span <= 125, f"a reading over {span} s"
    assert abs(ratio - 1) < 0.002, f"media/PTP {ratio}"
    assert abs(trim) <= 20.5, f"trim {trim} ppm in one step (limit 20)"
    assert len(pk) > 2500, f"{len(pk)} packets in 3 s"
    assert {p.payload_len for p in pk} == {2 * 3 * 48}, "the stream is no longer stereo"
    assert not discontinuities(pk, 48), "breaks in the stream with the trim on"


def test_without_the_setting_there_is_no_trim_loop(fppd, audio):
    """adaptiveResample is opt-in: a sender without it runs no loop, so a
    stream's pipeline isn't carrying an element known not to trim a live
    stream."""
    fppd.settings(LogLevel_MediaOut="debug")
    with RtpCapture(5004):
        start_sender(fppd, audio)
        time.sleep(3)
    assert "AES67 drift control thread started" not in fppd.log()
