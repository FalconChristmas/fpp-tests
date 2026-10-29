"""An E1.31 output set to send from a network interface that this machine
does not have: fppd says so, in its warnings, rather than sending from
wherever the default route points."""

from test_output_protocols import output


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
