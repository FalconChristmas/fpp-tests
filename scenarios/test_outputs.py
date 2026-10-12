"""Channel outputs: what reaches the network, and what config reloads do to it.

Outputs point at 127.0.0.1 and a udp.Listener counts what arrives. Test mode
keeps channel data flowing at a steady rate while a scenario saves configs.
"""

import time

from udp import Listener

GENERIC_PORT = 5000
# Somewhere E1.31 goes nowhere: at 127.0.0.1 it would reach fppd's own E1.31
# input bridge and feed back into the output thread. "monitor": 0, or fppd pings
# it, gets no answer, and reconfigures the output to drop it.
E131_ADDRESS = "192.0.2.1"


def universes(description):
    """co-universes.json: one unicast E1.31 universe to localhost."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [{"active": 1, "description": description, "id": 1,
                       "startChannel": 1, "channelCount": 512, "type": 1,
                       "address": E131_ADDRESS, "priority": 0, "monitor": 0,
                       "deDuplicate": 0}],
    }]}


def generic_udp(description, enabled=1):
    """co-other.json: one GenericUDP output to localhost."""
    return {"channelOutputs": [{
        "type": "GenericUDP", "enabled": enabled, "startChannel": 1, "channelCount": 3,
        "description": description, "address": "127.0.0.1", "port": GENERIC_PORT,
        "tokens": "",
    }]}


def start_test_mode(fppd):
    fppd.command("Test Start", "100", "RGB Cycle", "1-512", "R-G-B")


def steady_rate(listener, settle=1.5, window=2.0):
    """Packets per second once a reload has had time to land."""
    time.sleep(settle)
    return listener.rate(window)


def test_generic_udp_survives_config_saves(fppd):
    """Saving either output config leaves a GenericUDP output sending once
    per frame -- not silenced, not doubled -- and disabling it stops it.

    Regression: e2422ff8e. GenericUDP handed its data object to the shared
    UDP output and never took it back: saving the E1.31 config replaced the
    UDP output and silenced GenericUDP, each save of the Other outputs added
    another copy (15 -> 38 -> 76 packets/s), and disabling it stopped none.
    """
    with Listener(GENERIC_PORT) as listener:
        fppd.write("config/co-universes.json", universes("a"))
        fppd.write("config/co-other.json", generic_udp("a"))
        fppd.start()
        start_test_mode(fppd)

        # Test mode takes a couple of seconds to reach its steady frame rate.
        base = steady_rate(listener, settle=3)
        assert base > 3, f"GenericUDP is not sending under test mode ({base}/s)"

        def assert_like_base(after):
            rate = steady_rate(listener)
            assert 0.5 * base <= rate <= 1.6 * base, \
                f"after {after}: {rate:.1f} packets/s, was {base:.1f}"

        fppd.write("config/co-universes.json", universes("b"))
        assert_like_base("saving the E1.31 config")
        fppd.write("config/co-other.json", generic_udp("b"))
        assert_like_base("saving the Other outputs")
        fppd.write("config/co-other.json", generic_udp("c"))
        assert_like_base("saving the Other outputs again")

        fppd.write("config/co-other.json", generic_udp("c", enabled=0))
        rate = steady_rate(listener)
        assert rate == 0, f"a disabled GenericUDP output still sends {rate:.1f} packets/s"
