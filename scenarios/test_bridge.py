"""Network inputs (the E1.31 / DDP / ArtNet bridge)."""

from udp import Listener

E131_PORT = 5568


def ci_universes(channel_count):
    """ci-universes.json: one unicast E1.31 input universe."""
    return {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1,
        "channelCount": channel_count,
        "universes": [{"active": 1, "id": 1, "startChannel": 1, "size": channel_count,
                       "type": 1, "priority": 0, "address": ""}],
    }]}


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def e131_warnings(fppd):
    return [w for w in warnings(fppd) if "E1.31 input is off" in w]


def test_e131_port_taken_by_another_program(fppd):
    """With UDP 5568 already taken, fppd starts and runs without E1.31
    input, says so in a warning, and clears the warning once the port is
    free and the input config is saved again.

    Regression: the bridge called exit(1) when it could not bind, so fppd
    never started -- and a reload of the input config while running took
    the show down from the main loop, with systemd's restart failing the
    same way.
    """
    held = Listener(E131_PORT, host="0.0.0.0")
    try:
        fppd.start()
        assert e131_warnings(fppd), f"no warning about the E1.31 port: {warnings(fppd)}"
        # A reload while the port is still taken must not take fppd down.
        fppd.write("config/ci-universes.json", ci_universes(512))
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("fppd") == "running",
                      what="fppd to keep running through the input reload")
    finally:
        held.close()

    fppd.write("config/ci-universes.json", ci_universes(510))
    fppd.wait_for(lambda: not e131_warnings(fppd), timeout=15,
                  what="the warning to clear once the port is free")
