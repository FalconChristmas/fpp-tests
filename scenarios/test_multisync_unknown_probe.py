"""A controller fppd found by HTTP discovery that no detector recognises,
and the background probe that checks on it later."""

import time

from fake_devices import fake_devices, page, requests_seen
from test_controller_detection import discover, systems

ADDRESS = "10.88.0.8"
UNKNOWN = {"/": page("<html>Some other web page</html>")}


def test_a_probe_of_an_unrecognised_controller_keeps_it_listed(fppd):
    """A device whose front page no detector recognises is listed as
    "Unknown", and when it has been quiet for 80 minutes the background
    probe asks it again, gets the same page, and leaves fppd running with
    the device still listed.

    Regression: 7aa06ad08. With no detector matching, the probe's answer
    handler read a field of the (null) result to fill in the unknown
    system's entry, and fppd crashed on the first such probe."""
    with fake_devices({ADDRESS: UNKNOWN}):
        fppd.settings(MultiSyncHTTPSubnets=ADDRESS)
        fppd.start(fake_time="2026-11-02 12:00:00")
        fppd.wait_for(lambda: ADDRESS in systems(fppd), timeout=30, interval=0.5,
                      what="the unrecognised device to be listed")
        asked = len(requests_seen(ADDRESS))
        fppd.set_clock("2026-11-02 13:21:00")
        fppd.wait_for(lambda: len(requests_seen(ADDRESS)) > asked, timeout=90, interval=0.5,
                      what="fppd to probe the device that has been quiet for 81 minutes")
        time.sleep(3)   # the answer is read after the request is seen
        fppd.check_alive()
        assert ADDRESS in systems(fppd), "the device dropped out of the list after the probe"
