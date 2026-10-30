"""The PRU loader (util/BBBPruUtils.cpp) on an AM335x BeagleBone, against
the fake PRU subsystem of am335x.py and fakepruss.c: what fppd does when a
core it starts through remoteproc does not come up.

Device only: run with run-local.sh on a BeagleBone Black or a PocketBeagle.
The GPIO lines are the real ones, so stop the device's own fppd first.
Skipped elsewhere.
"""

import time

from am335x import FakePruss, write_string_cape
from bbcape import pixel_output, strings_config
from test_am335x_pru import string_pins


def test_a_core_that_never_comes_up_fails_its_output_and_says_so(fppd):
    """A BBB48String output whose PRU1 remoteproc start leaves the core
    offline (its firmware never boots) is refused, with a warning naming
    the core and the state it stayed in; fppd carries on.

    Regression: 63b5ff7df ("Give the PRU a little time to actually come
    online"). The loader wrote "start" and went straight on, never looking
    at the state again: a core that had not come up (yet, or at all) was
    taken as running, and the output fed frames to nothing.

    Regression: 0a91328f1. BBBPru::run() returned the same value whether or
    not the core came up, and the outputs ignored it: with enable()'s
    result dropped the output was added ("Init succeeded") all the same.
    """
    pru = FakePruss(fppd, states=("offline", "offline"), noboot=(1,))
    pins, _ = string_pins()
    write_string_cape("TestNoBoot", {"outputs": [{"pin": p} for p in pins[:2]]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBB48String", "TestNoBoot", [pixel_output(0, 10, 0), pixel_output(1, 10, 30)]))
    fppd.settings(LogLevel_ChannelOut="debug")
    pru.start()
    # The control: fppd asked remoteproc to start PRU1, and it stayed down.
    fppd.wait_for(lambda: "noboot 1" in pru.events(), timeout=30, what="PRU1's start")
    time.sleep(2)
    assert pru.remoteproc_state(1) == "offline"
    log = fppd.log()
    assert "could not start PRU core 1" in log and "State: offline" in log, fppd.tail(60)
    assert "Init succeeded, adding to channel outputs" not in log, fppd.tail(60)
    fppd.get("/fppd/status")
    assert "Crash handler called" not in fppd.log(), fppd.tail()
