"""The input bridge's own state stays its own when another object in the
process exports a global of the same common name."""

import os
import time

import shims
from packets import E131_PORT, Sender, e131
from test_bridge_inputs import E131_SIZE, E131_START, region, setup, wait_output
from udp import Listener

OUT_PORT = 5000


def test_bridge_globals_are_not_bound_to_another_objects_symbols(fppd):
    """With a preloaded object exporting globals named "addr" and "msgs",
    the bridge starts and bridges E1.31 without ever writing to them.

    Regression: 534c55227. The bridge's file-scope globals (addr, msgs,
    buffers and others) were exported from libfpp under those names, so
    its references went through the GOT and bound to the first definition
    in the process: here the preloaded one, which the bridge's setup
    zeroed. In the field that was a fault on bridge init at a fixed bogus
    address.
    """
    marker = os.path.join(fppd.media, "tmp", "interposed")
    setup(fppd)
    data = bytes([0x3C]) * E131_SIZE
    with Listener(OUT_PORT) as out:
        fppd.start(preload=[shims.build("interpose.c", libs=("-ldl", "-lpthread"))],
                   extra_env={"INTERPOSE_FILE": marker})
        with Sender(lambda n: [(e131(10, data, seq=n), E131_PORT)]):
            wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == data,
                        "the bridged E1.31 data")
        time.sleep(0.5)  # the shim looks every 20 ms
    written = open(marker).read().strip() if os.path.exists(marker) else None
    assert written is None, f"libfpp wrote to the preloaded object's {written!r}"
