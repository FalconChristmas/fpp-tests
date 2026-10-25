"""The PocketBeagle 2's pin table in fppd (util/BBBUtils.cpp): which header
pin an output muxes for what it opens.

Device only: run with run-local.sh on a PocketBeagle 2, whose stub pinctrl
logs the mux requests without touching a pad (hosttools.py). Skipped
elsewhere.
"""

import pytest

import hosttools


def pocketbeagle2():
    try:
        with open("/proc/device-tree/model") as f:
            return "PocketBeagle2" in f.read()
    except OSError:
        return False


def test_a_serial_output_on_ttys6_muxes_uart2s_transmit_pin(fppd):
    """A GenericSerial output on /dev/ttyS6 muxes P2-04 to its UART: on the
    PocketBeagle 2 ttyS6 is the device tree's alias for UART2, whose
    transmit is on P2-04.

    Regression: 661545976 (fppd's table; the pinctrl half is built into
    the image). The table named the UARTs by TI's numbers, so ttyS6 was
    taken for UART6 and P1-12 was muxed -- the console's transmit line --
    while the data went out of UART2 on a pin nobody had muxed.
    """
    if not pocketbeagle2():
        pytest.skip("needs a PocketBeagle 2 under run-local.sh")
    if not hosttools.stubbed("pinctrl"):
        pytest.skip("needs run-local.sh's stub pinctrl")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericSerial", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "device": "ttyS6", "speed": 115200, "header": "", "footer": ""}]})
    calls = hosttools.pinctrl_calls()
    fppd.start(timeout=60)
    muxed = [c for c in calls.calls() if c.endswith(" uart")]
    assert "-s P2_04 uart" in muxed, calls.calls()
    assert not any("P1_12" in c for c in muxed), calls.calls()
