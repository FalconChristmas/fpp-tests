"""The network input bridge on an FPP in remote mode with no master: E1.31
input still reaches the outputs. Same harness as test_bridge_inputs.py:
packets streamed to fppd on 127.0.0.1, and what comes back out read off a
raw output."""

import time

from packets import E131_PORT, Sender, e131
from test_bridge_inputs import E131_SIZE, E131_START, region, setup, wait_output
from udp import Listener

OUT_PORT = 5000


def test_bridged_e131_reaches_the_outputs_in_remote_mode(fppd):
    """A remote with no master sending it sync, fed E1.31 on a configured
    input universe: the data goes out on its channels within a second of
    arriving, and follows each change to it.

    Regression: 6232b1393. Bridged data didn't count as a reason to output,
    so in remote mode the output thread waited for a master's sync, gave up
    after two seconds and stopped, and nothing bridged was sent."""
    setup(fppd)
    fppd.settings(fppMode="remote")
    value = [0x21]

    def packets(n):
        return [(e131(10, bytes([value[0]]) * E131_SIZE, seq=n % 256), E131_PORT)]

    with Listener(OUT_PORT) as out:
        fppd.start()
        with Sender(packets):
            for v in (0x21, 0x42, 0x63):
                value[0] = v
                want = bytes([v]) * E131_SIZE
                changed = time.monotonic()
                wait_output(fppd, out, lambda f: region(f, E131_START, E131_SIZE) == want,
                            f"the bridged value {v:#x} on the output", timeout=5)
                assert time.monotonic() - changed < 1.5, \
                    f"the output took {time.monotonic() - changed:.1f} s to follow the input"
