"""What /aes67/status and /aes67/test report about streams that are running,
and the optional pipeline statistics. The sender runs as in test_aes67_wire.py."""

import re

import pytest

from fppd import sanitizer
from test_aes67_wire import start_sender

pytestmark = pytest.mark.skipif(sanitizer() == "tsan", reason="timing scenarios; see test_aes67_wire.py")

SEND = {"id": 1, "name": "tx", "mode": "send", "enabled": True, "sapEnabled": False,
        "multicastIP": "127.0.0.1", "port": 5004, "channels": 2}
RECEIVE = {"id": 2, "name": "rx", "mode": "receive", "enabled": True, "sapEnabled": False,
           "multicastIP": "127.0.0.1", "port": 5006}


def test_status_lists_each_running_stream(fppd, audio):
    """A sender and a receiver: /aes67/status lists both by id and name, running,
    and gives the sender the rate its source negotiated."""
    start_sender(fppd, audio, instances=[SEND, RECEIVE])
    fppd.wait_for(lambda: "AES67 recv pipeline [2] rx started" in fppd.log(), timeout=30,
                  what="the receive pipeline to start")

    def pipelines():
        return {p["instanceId"]: p for p in fppd.get("/aes67/status")["pipelines"]}
    fppd.wait_for(lambda: pipelines().get(1, {}).get("sourceRate") == 48000, timeout=20, interval=0.25,
                  what=f"the sender's source rate; have {pipelines()}")
    tx, rx = pipelines()[1], pipelines()[2]
    assert (tx["name"], tx["mode"], tx["running"]) == ("tx", "send", True), tx
    assert (rx["name"], rx["mode"], rx["running"]) == ("rx", "receive", True), rx
    assert "error" not in tx and "error" not in rx, (tx, rx)


def test_the_self_test_reports_running_streams_and_the_sdp(fppd, audio):
    """/aes67/test says the sender and receiver are running, and builds a valid
    SDP for the first instance."""
    start_sender(fppd, audio, instances=[SEND, RECEIVE])
    fppd.wait_for(lambda: "AES67 recv pipeline [2] rx started" in fppd.log(), timeout=30,
                  what="the receive pipeline to start")
    tests = {t["test"]: t for t in fppd.get("/aes67/test", timeout=30)["tests"]}
    assert tests["send_pipeline_1"]["passed"], tests["send_pipeline_1"]
    assert tests["send_pipeline_1"]["message"] == "Send pipeline 1 is running"
    assert tests["recv_pipeline_2"]["passed"], tests["recv_pipeline_2"]
    assert tests["recv_pipeline_2"]["message"] == "Receive pipeline 2 is running"
    assert tests["sdp_generation"]["passed"], tests["sdp_generation"]
    assert re.fullmatch(r"SDP generation OK \(\d+ bytes\)", tests["sdp_generation"]["message"])


def test_the_pipeline_statistics_measure_the_stream(fppd, audio):
    """pipelineStats on: every 30 s the log gives the bytes in and out. A stereo
    24-bit stream at 48 kHz is 288 kB/s, plus an RTP header per millisecond's
    packet, and what goes out is about what comes in. (Takes over 30 s.)"""
    fppd.settings(LogLevel_MediaOut="info")
    start_sender(fppd, audio, pipelineStats=True)
    assert "AES67 send [1]: pipeline stats on" in fppd.log()
    stats = re.compile(r"AES67 stats \[1\]: pipewiresrc (\d+) B/s, udpsink (\d+) B/s, ratio ([0-9.]+), "
                       r"totals in (\d+) out (\d+)")
    found = fppd.wait_for(lambda: stats.search(fppd.log()), timeout=45, interval=1,
                          what="the first statistics line")
    in_rate, out_rate, ratio = int(found[1]), int(found[2]), float(found[3])
    assert in_rate > 0 and 280000 < out_rate < 310000, found[0]
    assert abs(ratio - out_rate / in_rate) < 0.01, found[0]
