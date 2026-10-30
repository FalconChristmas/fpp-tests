"""The tree's own pinctrl tool for a PocketBeagle2 (AM62x): the PRU modes of
P2-28, against the pad register file of test_pb2_pinctrl.py (fakepadmem.c
gives the tool a sparse file for /dev/mem and fakes the board model).

Runs wherever the tool is built (run-local.sh on a Beagle, with
capes/drivers/pinctrl built in the tree). Skipped elsewhere.
"""

from test_pb2_pinctrl import pads, set_mode  # noqa: F401 (pads is a fixture)

MODE_MASK = 0xF


def test_p2_28_is_muxed_to_the_pru0_input_mode(pads):  # noqa: F811
    """"pinctrl -s P2_28 pru0in", as fppd asks for a Falcon V5 listener on
    P2-28, puts ball AB24 (pad 0x0F8 of the main domain) in mode 6,
    pr0_pru0_gpi; its pru1in mode (3) is the control.

    Regression: 301e7fe49 (its AM6232.cpp half; the listener and shift
    firmware timing it also changes is electrical). AB24's PRU0 modes were
    based at 0, so pru0in wrote mode 1, a GPMC function, and a listener on
    P2-28 heard nothing.
    """
    set_mode(pads, "P2_28", "pru1in")
    assert pads.reg("main", 0x0F8) & MODE_MASK == 3, hex(pads.reg("main", 0x0F8))
    set_mode(pads, "P2_28", "pru0in")
    reg = pads.reg("main", 0x0F8)
    assert reg & MODE_MASK == 6, f"pru0in left AB24 at {reg:#x}"
