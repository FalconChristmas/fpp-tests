"""A PocketBeagle 2 found by fppd's HTTP controller discovery: its type
comes from the remote's 'Variant', which on a PocketBeagle 2 is the model
spelled with a space. The remote is a fake FPP in its own network namespace
(fake_devices.py), as in test_controller_detection.py.
"""

import pytest

from fake_devices import fake_devices, page

POCKETBEAGLE2 = 0x47  # kSysTypeFPPPocketBeagle2
POCKETBEAGLE = 0x45   # kSysTypeFPPPocketBeagle


def fpp(variant):
    return {
        "/": page("<html><title>Falcon Player - FPP</title></html>"),
        "/api/system/info": page({"HostName": "fake-pb2", "Version": "10.0", "Variant": variant,
                                  "Mode": "remote", "majorVersion": 10, "minorVersion": 0,
                                  "uuid": "M1-fake-pb2-uuid", "channelRanges": "0-511"}),
    }


@pytest.mark.parametrize("variant", ["PocketBeagle 2", "PocketBeagle 2 Industrial"])
def test_a_discovered_pocketbeagle_2_is_typed_as_one(fppd, variant):
    """An FPP whose Variant reads "PocketBeagle 2" (or "... Industrial") is
    listed as a PocketBeagle 2, not a PocketBeagle.

    Regression: 182f119c2 (the discovery half; the Variant itself is
    config.php's, and telling the Industrial apart needs that board).
    ModelStringToType() only knew the device-tree spelling,
    "PocketBeagle2", so the spaced Variant fell through to the PocketBeagle
    test and a PocketBeagle 2 was reported as a PocketBeagle 1.
    """
    with fake_devices({"10.88.0.2": fpp(variant)}):
        fppd.settings(MultiSyncHTTPSubnets="10.88.0.2")
        fppd.start()

        def found():
            return [s for s in fppd.get("/fppd/multiSyncSystems")["systems"]
                    if s.get("address") == "10.88.0.2"]
        got = fppd.wait_for(found, timeout=30, interval=0.5, what="the remote to be listed")
    assert got[0]["typeId"] == POCKETBEAGLE2, got
