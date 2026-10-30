"""An E1.31 output set to send from a network interface that this machine
does not have: fppd says so, in its warnings, rather than sending from
wherever the default route points."""

import time

from packets import E131_PORT, parse_e131
from test_output_protocols import output, packets
from udp import Listener


def test_an_output_interface_that_does_not_exist_is_warned_about(fppd):
    """A multicast E1.31 output whose interface is a name no interface has
    raises "Invalid interface for UDP broadcast/multicast: <name>".

    Regression: f56a4f5a3. GetInterfaceAddress() answered 127.0.0.1 for an
    interface it could not ask about and reported success; UDPOutput took
    that as a loopback address and quietly sent no broadcast or multicast,
    with nothing in the UI to say the interface was wrong."""
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "interface": "fppnosuch0", "universes": [output(0, 1, 1, 510)]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.request("PUT", "/overlays/range/1-510", {"Value": 42})
    fppd.wait_for(lambda: "Invalid interface for UDP broadcast/multicast: fppnosuch0"
                  in fppd.get("/fppd/status").get("warnings", []),
                  timeout=10, what="the invalid-interface warning")


def test_a_unicast_output_ignores_an_interface_that_does_not_exist(fppd):
    """A unicast E1.31 output with an output interface that no interface
    has sends to its controller anyway (the operating system routes it) and
    raises no invalid-interface warning: the interface matters only to
    broadcast and multicast.

    Regression: 6efd4cf0b (the source interface applies only to broadcast and
    multicast) and 0713ec875 (no complaint about one that is not needed).
    A unicast output with a bad interface sent nothing, and the page said the
    interface was invalid for an output that does not use one."""
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "interface": "fppnosuch0", "universes": [output(1, 1, 1, 510)]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with Listener(E131_PORT) as rx:
        fppd.start()
        fppd.request("PUT", "/overlays/range/1-510", {"Value": 42})
        fppd.wait_for(lambda: any((parse_e131(p) or {}).get("data", b"")[:1] == b"\x2a" for p in packets(rx)),
                      timeout=10, what="a unicast packet carrying the lit channels")
        time.sleep(1)
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not [w for w in warnings if "Invalid interface" in w], warnings
