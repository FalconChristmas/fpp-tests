"""How a UDP output hands a frame to the kernel.

A frame of many universes is sent to a socket whose send buffer holds only
a few packets, so the output sends it in small sendmmsg() batches and waits
for the buffer to drain between them. co_sendmmsglog.so logs each
sendmmsg() and each send-buffer check (SIOCOUTQ) fppd makes.
"""

import os
import time

import shims
from udp import Listener

UNIVERSES = 30
PORT = 5568


def e131_config(universes=UNIVERSES):
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1,
        "channelCount": universes * 510,
        "universes": [{"active": 1, "description": "c", "id": 1, "startChannel": 1,
                       "channelCount": 510, "universeCount": universes, "type": 1,
                       "address": "127.0.0.1", "priority": 0, "monitor": 0,
                       "deDuplicate": 0}]}]}


def universes_seen(rx):
    with rx.lock:
        return {(d[113] << 8) | d[114] for _, d in rx.packets if len(d) > 125}


def test_a_big_frame_goes_out_in_small_batches_with_the_buffer_drained(fppd):
    """A 30-universe E1.31 unicast frame is sent with sendmmsg() calls of
    at most 8 packets, each followed by a check that the socket's send
    buffer has drained; every universe still arrives.

    Regression: fa1475b44. A frame went to the socket in one sendmmsg()
    with nothing checking the send buffer, so a destination that drained
    slowly had packets dropped at the sender; the output now sends 8 at a
    time and waits (SIOCOUTQ) for the buffer to empty before the next batch.
    """
    log = os.path.join(fppd.media, "tmp", "sendmmsg.log")
    fppd.write("config/co-universes.json", e131_config())
    fppd.settings(DisableFakeNetworkBridges="1")
    with Listener(PORT) as rx:
        fppd.start(preload=[shims.build("co_sendmmsglog.c")], extra_env={"SENDMMSGLOG": log})
        fppd.request("PUT", "/overlays/range/1-%d" % (UNIVERSES * 510), {"Value": 42})
        fppd.wait_for(lambda: len(universes_seen(rx)) == UNIVERSES, timeout=15,
                      what="a packet for every universe")
        time.sleep(1)
        got = universes_seen(rx)
    lines = [l.split() for l in open(log)] if os.path.exists(log) else []
    batches = [int(l[2]) for l in lines if l[0] == "sendmmsg"]
    checks = [l for l in lines if l[0] == "outq"]
    assert len(got) == UNIVERSES, f"universes received: {sorted(got)}"
    assert batches and max(batches) == 8, f"sendmmsg batch sizes: {sorted(set(batches))}"
    assert checks, "the send buffer was never checked between batches"
