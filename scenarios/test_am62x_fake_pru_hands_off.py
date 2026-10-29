"""An AM62x fppd in its FAKE_PRU mode (no /sys/class/remoteproc/remoteproc0,
as on a pre-production PocketBeagle2, and as run-local.sh presents every
AM62x board -- see bbcape.py): its PRU outputs run against ordinary memory
and leave the PRU cores and their driver alone, from start to stop.

Device only: run with run-local.sh on a PocketBeagle2. The cores' real
remoteproc files, under /sys/devices, are on run-local.sh's read-only /sys,
so a write to one is a logged failure here; modprobe is run-local.sh's stub,
which logs its calls to /tmp/kmod.log.
"""

import os

from bbcape import fake_pru, pixel_output, strings_config, write_string_cape

KMOD_LOG = "/tmp/kmod.log"


def kmod_calls():
    try:
        with open(KMOD_LOG) as f:
            return f.read().splitlines()
    except OSError:
        return []


def test_a_fake_pru_output_loads_no_pru_driver_and_stops_no_core(fppd):
    """A string output in FAKE_PRU mode starts and stops, with fppd neither
    loading the PRU remoteproc driver nor writing "stop" to a core's
    remoteproc state.

    Regression: 3ba7b12d1 ("Fix fppd startup on pre-production pb2").
    initPrus() ran `modprobe pru_rproc` whenever remoteproc0 was missing,
    and BBBPru::stop() stopped the core through remoteproc even in FAKE_PRU
    mode -- on a board whose PRUs the fake mode exists to stay away from.
    """
    fake_pru(fppd)
    fppd.settings(LogLevel_ChannelOut="debug")
    write_string_cape("TestHandsOff", {"driver": "BBShiftString", "outputs": [
        {"pru": 1, "pin": p, "index": i} for p in range(2) for i in range(8)]})
    fppd.write("config/co-bbbStrings.json", strings_config(
        "BBShiftString", "TestHandsOff", [pixel_output(0, 20, 0)]))
    before = len(kmod_calls())
    fppd.start(timeout=90)
    # The control: the output started, its program run on PRU1.
    fppd.wait_for(lambda: "BBBPru[1]::run(" in fppd.log(), timeout=30, what="the string output to start")
    assert "Init succeeded, adding to channel outputs" in fppd.log(), fppd.tail(60)
    fppd.exit_expected = True
    assert fppd.stop() == 0, fppd.tail(60)
    log = fppd.log()
    assert "Crash handler called" not in log, fppd.tail()
    assert "BBBPru::Pru::disable()" not in log, fppd.tail(60)
    assert [c for c in kmod_calls()[before:] if "pru_rproc" in c] == [], kmod_calls()[before:]
