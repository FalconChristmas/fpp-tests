"""A UDP output aimed at the player's own address: switched off with a
warning by default, left running when "Disable Network Bridge Monitoring
(E1.31/DDP/ArtNet)" is set."""

import time

from ddp import DdpReceiver
from show import ddp_output

CHANNELS = 150


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def range_on(fppd, channels, value):
    fppd.request("PUT", f"/overlays/range/1-{channels}", {"Value": value})


def test_output_to_self_keeps_sending_when_bridge_monitoring_is_disabled(fppd):
    """A DDP output aimed at 127.0.0.1 with DisableFakeNetworkBridges set
    sends its data (the receiver on that address gets the lit channels) and
    raises no "sending to myself" warning.

    Regression: 2f5e4e3ed. Every UDP output aimed at one of the player's own
    addresses was switched off at load, whatever the setting, so a player
    could not drive a receiver on the same box (a bridge, a loopback
    check)."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.1"))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        range_on(fppd, 10, 42)
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the output aimed at itself to send")
    assert "UDP Output set to send data to myself" not in fppd.log()
    assert not any("send data to myself" in w for w in warnings(fppd)), warnings(fppd)


def test_output_to_self_is_switched_off_by_default(fppd):
    """Without the setting, the same output is disabled with a warning and
    the receiver on that address never gets a packet (the control for the
    test above: it shows the setting is what lets the data through)."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS, address="127.0.0.1"))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.wait_for(lambda: any("send data to myself" in w for w in warnings(fppd)),
                      timeout=10, what="the sending-to-myself warning")
        range_on(fppd, 10, 42)
        time.sleep(2)
        assert rx.last() is None or rx.last()[:10] != bytes([42] * 10)
