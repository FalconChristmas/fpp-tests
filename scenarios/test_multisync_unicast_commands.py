"""Where a master sends an FPP Command packet: to the one remote it names,
and by multicast only when no other method is set up."""

import time

from capture import UdpCapture
from multisync import PORT
from show import CHANNELS, ddp_output
from test_multisync import parse_fpp_command
from test_multisync_systems import interface

FIRST = "127.0.0.2"
SECOND = "127.0.0.3"
ARGS = ["Cmd", "Value", "x", "1", "0", "100", ""]


def commands(cap):
    return [c for c in (parse_fpp_command(p) for _, _, _, p in cap.snapshot()) if c]


def test_a_command_for_one_remote_is_sent_to_that_remote_only(fppd):
    """A MultiSync command aimed at one host goes to that host by unicast;
    the master's other remotes don't get it.

    Regression: 7e89f7af4. Every FPP Command packet went out through the
    general send, to all of the master's remotes at once (and over
    multicast and broadcast), whichever host it named; the others had to
    read it and drop it."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=f"{FIRST},{SECOND}", DisableFakeNetworkBridges="1")
    with UdpCapture(PORT, FIRST) as first, UdpCapture(PORT, SECOND) as second:
        fppd.start()
        fppd.post("/command", {"command": "Set Variable", "multisyncCommand": True,
                               "multisyncHosts": FIRST, "args": ARGS})
        time.sleep(1)
        got_first, got_second = commands(first), commands(second)
    assert (FIRST, "Set Variable", ARGS) in got_first, got_first
    assert not got_second, f"a command for {FIRST} also went to {SECOND}: {got_second}"


def test_a_master_with_remotes_does_not_also_multicast(fppd):
    """With remotes chosen, a command for every host goes to them and not
    to the multicast group as well: multicast is only the fallback when no
    send method is set up.

    Regression: e2864eb38. Any master with MultiSync on added the multicast
    group to its remotes, so each packet went out twice on a network that
    delivers both. fppd multicasts on its non-loopback interfaces only, so
    the packets are watched leaving a dummy one."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=FIRST, DisableFakeNetworkBridges="1")
    with interface("10.77.0.1"), UdpCapture(PORT, "239.70.80.80", iface="fpptest0") as multicast, \
            UdpCapture(PORT, FIRST) as unicast:
        fppd.start()
        fppd.post("/command", {"command": "Set Variable", "multisyncCommand": True,
                               "multisyncHosts": "", "args": ARGS})
        time.sleep(1)
        by_unicast, by_multicast = commands(unicast), commands(multicast)
    assert ("", "Set Variable", ARGS) in by_unicast, by_unicast
    assert not by_multicast, f"the command was also multicast: {by_multicast}"
