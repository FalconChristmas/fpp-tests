"""fpp-info.json on a player with no network address: fppd writes the file
from its MultiSync entry, which carries the player's addresses; with none
there is no entry to describe, and a record with an empty address list would
break whatever reads it (the system status API among them).
"""

import json
import os

import shims
from test_multisync_systems import interface


def info_path(fppd):
    return os.path.join(fppd.media, "fpp-info.json")


STALE = {"HostName": "stale-host", "addresses": "10.9.9.9", "channelRanges": "0-0"}


def test_no_address_removes_a_stale_fpp_info_and_writes_no_empty_record(fppd):
    """With an address, fppd replaces a leftover fpp-info.json with the
    current record.  With no non-loopback address, it removes the leftover
    and writes nothing in its place.

    Regression: 2d2bbee81 (#1238). fppd wrote the file whatever it found, so
    with no network the record was empty of addresses (and the previous
    run's record stayed on disk), and /api/system/status, which reads it,
    came back corrupt.
    """
    # The control: with an address the stale file is replaced.
    with open(info_path(fppd), "w") as f:
        json.dump(STALE, f)
    with interface("10.77.0.1"):
        fppd.start()
        fppd.wait_for(lambda: "10.77.0.1" in open(info_path(fppd)).read(), timeout=10, interval=0.2,
                      what="fpp-info.json to carry the player's address")
        fppd.stop()

    # No address: the file goes.
    with open(info_path(fppd), "w") as f:
        json.dump(STALE, f)
    fppd.start(preload=[shims.build("noaddrs.c")])
    fppd.wait_for(lambda: not os.path.exists(info_path(fppd)), timeout=10, interval=0.2,
                  what="the stale fpp-info.json to be removed")
    fppd.wait_for(lambda: "no IP addresses found" in fppd.log(), timeout=10, interval=0.2,
                  what="fppd to say it found no address to describe the player by")
