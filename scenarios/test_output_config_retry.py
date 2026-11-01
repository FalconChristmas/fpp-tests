"""A channel output config that can't be read when fppd reloads it."""

import os
import time

import shims
from udp import Listener


def generic_udp(port):
    return {"channelOutputs": [{
        "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "address": "127.0.0.1", "port": port, "tokens": "{data}"}]}


def test_a_reload_that_reads_nothing_tries_the_file_again(fppd):
    """co-other.json is saved to send to another port while its first read
    comes back empty, as a read racing the writer does; the output still
    moves to the new port, with no parse warning.

    co_tornread.so makes the first fopen() of co-other.json after the save
    open /dev/null instead.

    Regression: 8a2828825. A reload read the file once; an empty or
    half-written file raised "Could not parse co-other.json. Some outputs
    may not work." and the old output was torn down for nothing. The load
    is now tried again after 5 ms.
    """
    arm = os.path.join(fppd.media, "tmp", "torn.arm")
    fppd.write("config/co-other.json", generic_udp(9000))
    # GenericUDP sends through the universes output, so one has to exist
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "universes": [{"active": 1, "description": "d", "id": 1, "universeCount": 1,
                       "startChannel": 1, "channelCount": 10, "type": 5, "address": "127.0.0.1",
                       "priority": 0, "monitor": 0, "deDuplicate": 0}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.settings(LogLevel_ChannelOut="debug")
    with Listener(9000) as old, Listener(9001) as new:
        fppd.start(preload=[shims.build("co_tornread.c")],
                   extra_env={"TORNREAD_SUFFIX": "/co-other.json", "TORNREAD_ARM": arm})
        fppd.request("PUT", "/overlays/range/1-10", {"Value": 42})
        fppd.wait_for(lambda: old.count_since(0) > 0, timeout=10, what="the first output to send")
        open(arm, "w").close()
        time.sleep(1.1)
        fppd.write("config/co-other.json", generic_udp(9001))
        fppd.wait_for(lambda: not os.path.exists(arm), timeout=10, what="the torn read")
        fppd.wait_for(lambda: new.count_since(0) > 0, timeout=10,
                      what="the output to move to the new port")
    warns = [w for w in fppd.get("/fppd/status").get("warnings", []) if "Could not parse" in w]
    assert not warns, warns
    gave_up = [l for l in fppd.log().splitlines() if "Error parsing" in l and "co-other.json" in l]
    assert not gave_up, gave_up
