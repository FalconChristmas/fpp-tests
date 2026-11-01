"""A SAP-announcing sender keeps one session identity: its SDP o= line
(session id and version) does not change on an Apply or a restart of fppd
that changes nothing."""

import time

from test_aes67_wire import apply_relinking, start_sender

SAP_SENDER = [{"id": 1, "name": "tx", "mode": "send", "enabled": True, "sapEnabled": True,
               "multicastIP": "127.0.0.1", "port": 5004, "channels": 2}]
VERSIONED = "announcement content changed, SDP version now"


def origin(fppd):
    sdp = fppd.get("/aes67/sdp")["streams"][0]["sdp"]
    return sdp.split("\r\n")[1]


def test_the_sdp_version_survives_an_apply_and_a_restart(fppd, audio):
    """With SAP on, the version in o= is minted once for the announced
    content and persisted: an Apply and a restart of fppd with the same
    config announce the same o= line, and the announcer logs a new version
    only the first time.

    Feature: 989edbd88 (a stable SAP identity instead of a new session on
    every restart)."""
    start_sender(fppd, audio, instances=SAP_SENDER)
    fppd.wait_for(lambda: VERSIONED in fppd.log(), timeout=30,
                  what="the first announcement to be versioned")
    before = origin(fppd)
    assert before.split()[2] != "1", f"the version was never stamped by an announcement: {before}"
    apply_relinking(fppd, audio)
    time.sleep(3)
    assert origin(fppd) == before, "the o= line changed on an Apply"
    assert fppd.log().count(VERSIONED) == 1, \
        "\n".join(l for l in fppd.log().splitlines() if "SAP" in l)
    assert fppd.stop() == 0
    start_sender(fppd, audio, instances=SAP_SENDER)
    time.sleep(5)
    assert origin(fppd) == before, "the o= line changed across a restart"
    assert fppd.log().count(VERSIONED) == 1, \
        "\n".join(l for l in fppd.log().splitlines() if "SAP" in l)
