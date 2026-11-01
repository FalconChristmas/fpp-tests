"""ArtNet unicast outputs are monitored by ping like the other UDP outputs."""

import pytest

from show import CHANNELS


def warning_ids(fppd, wid):
    return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])
            if w.get("id") == wid]


@pytest.mark.parametrize("kind", [3, 9], ids=["artnet-port", "own-port"])
def test_unreachable_artnet_controller_raises_the_ping_warning(fppd, kind):
    """A unicast ArtNet output with monitoring on, to an address nothing
    answers, raises the unreachable-controller warning (27), both for ArtNet
    sent from 6454 (type 3) and from a port of its own (type 9).

    Regression: ea7acf0c7. ArtNet's IsPingable() compared the type against
    a single unicast define (the 6454 one), so the other unicast type was
    never pinged and a dead controller never raised a warning.
    """
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": CHANNELS,
        "universes": [{"active": 1, "description": "test controller", "id": 1,
                       "startChannel": 1, "channelCount": CHANNELS, "type": kind,
                       "address": "10.77.0.2",   # nothing answers here
                       "priority": 0, "monitor": 1, "deDuplicate": 0}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    msgs = fppd.wait_for(lambda: warning_ids(fppd, 27), timeout=120, interval=1,
                         what="the unreachable-controller warning")
    assert any("10.77.0.2" in m for m in msgs), msgs
