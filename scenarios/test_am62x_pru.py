"""The PRU loader (util/BBBPruUtils.cpp) on an AM62x board: remoteproc
start/stop of the cores.

Device only: run with run-local.sh on a PocketBeagle2. These scenarios take
fppd out of its FAKE_PRU mode without touching the real PRUs: a remoteproc
state file is planted in run-local.sh's empty /sys/class/remoteproc (FAKE_PRU
keys off it) and co_fakedevmem.so hands fppd ordinary memory for /dev/mem.
The cores' own remoteproc files, under /sys/devices, are the real ones, on
run-local.sh's read-only /sys. Skipped elsewhere.
"""

import os

import pytest

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape
import shims

PLANTED = "/sys/class/remoteproc/remoteproc0"
CORE_STATE = "/sys/devices/platform/bus@f0000/30040000.pruss/30078000.pru/remoteproc"


@pytest.fixture
def fake_memory_pru(fppd):
    """fppd started with this runs the real-PRU path against fake memory."""
    fake_pru(fppd)
    if not os.path.isdir(CORE_STATE):
        pytest.skip("no PRU1 remoteproc device on this board")
    os.makedirs(PLANTED, exist_ok=True)
    with open(os.path.join(PLANTED, "state"), "w") as f:
        f.write("offline\n")
    try:
        yield [shims.build("co_fakedevmem.c")]
    finally:
        os.remove(os.path.join(PLANTED, "state"))
        os.rmdir(PLANTED)


def test_a_remoteproc_state_file_that_cannot_be_opened_fails_the_output(fppd, fake_memory_pru):
    """When a PRU core's remoteproc state file can't be opened for writing
    (here /sys is read-only), starting a string output on it logs which
    file and refuses the output; fppd carries on.

    Regression: 6ccab1063. Pru::disable() and enable() wrote "stop" and
    "start" through an unchecked fopen(): fprintf() on the null FILE*,
    SIGSEGV at startup.

    Also covers b433f977a: the state file named is the core's own, found
    under its PRU device; /sys/class/remoteproc/remoteproc<core> was named
    before, which is another core (or none) once the M4 cores are enabled
    and renumber the remoteprocs -- here PRU1 never started (10 s wait).
    """
    write_string_cape("TestShift16", {"driver": "BBShiftString", "outputs": [
        {"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestShift16", [pixel_output(0, 20, 0)]))
    fppd.start(timeout=60, preload=fake_memory_pru)
    log = fppd.log()
    assert "Crash handler called" not in log, fppd.tail()
    assert "could not open /sys/devices/platform/bus@f0000/30040000.pruss/30078000.pru/" in log, fppd.tail()
    fppd.get("/fppd/status")
