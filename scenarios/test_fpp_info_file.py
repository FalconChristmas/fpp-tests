"""fpp-info.json: the summary of this box fppd writes to the media directory
(its local MultiSync entry: host name, type, version, addresses, channel
ranges), which the crash report and anything reading the media directory
take as the box's current state.
"""

import json
import os

from test_multisync_systems import interface


def universes(start, count):
    """co-universes.json: one E1.31 output universe of `count` channels
    from channel `start` (1-based)."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": start, "channelCount": count,
        "universes": [{"active": 1, "description": "", "id": 1, "startChannel": start,
                       "size": count, "type": 1, "address": "10.20.30.46", "priority": 0,
                       "monitor": 0, "deDuplicate": 0, "channelCount": count}]}]}


def info(fppd):
    try:
        with open(os.path.join(fppd.media, "fpp-info.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def test_fpp_info_follows_a_change_of_the_outputs(fppd):
    """fpp-info.json carries the channel ranges of the outputs fppd started
    with, and when the output config is changed while fppd runs (which
    fppd picks up without a restart) it is rewritten with the new ranges.

    Regression: c06938ddc. The file was written once, at startup, so after
    an output change it kept the old ranges until fppd was restarted.
    """
    fppd.write("config/co-universes.json", universes(1, 512))
    with interface("10.77.0.1"):
        fppd.start()
        fppd.wait_for(lambda: info(fppd).get("channelRanges") == "0-511", timeout=10, interval=0.2,
                      what=f"fpp-info.json to carry the starting ranges: {info(fppd)}")
        assert "10.77.0.1" in info(fppd).get("addresses", ""), info(fppd)
        fppd.write("config/co-universes.json", universes(1001, 100))
        fppd.wait_for(lambda: info(fppd).get("channelRanges") == "1000-1099", timeout=10, interval=0.2,
                      what=f"fpp-info.json to carry the new ranges: {info(fppd)}")


def test_no_outputs_means_a_range_of_eight_channels(fppd):
    """With no output enabled, the channels this box says it needs are 0-7, so
    a sparse sequence made from its ranges stays small.

    Regression: 1d26c631e. No outputs meant every channel, all 8M of them."""
    fppd.start()
    local = next(s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s["local"])
    assert local["channelRanges"] == "0-7", local
