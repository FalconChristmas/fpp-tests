"""Where a master sends an FPP Command packet: to the one remote it names,
and by multicast only when no other method is set up."""

import time

from capture import UdpCapture
from multisync import PORT, fpp_command_packet
from show import CHANNELS, ddp_output
from test_multisync import parse_fpp_command
from test_multisync_systems import interface, send
from test_schedule_calendar import YEAR, ZONE, entry

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


def test_a_command_runs_where_any_name_in_its_host_list_matches(fppd):
    # Also guards 4290756c7: a host named by its address, as this system knows it.
    """A MultiSync command's host list runs it on a system named anywhere in
    the list, by host name or by address, and nowhere else.

    Regression: dd801b564. Only the host name, as the whole list, matched."""
    def sent(host, value):
        send(fpp_command_packet("Set Variable", ["V", "Value", value, "1", "0", "100", ""], host=host))

    def value():
        return (fppd.get("/variables") or {}).get("V", {}).get("value")

    fppd.settings(HostName="stage")
    with interface("10.77.0.1"):
        fppd.start()
        fppd.wait_for(lambda: any(s.get("local") and s["address"] == "10.77.0.1"
                                  for s in fppd.get("/fppd/multiSyncSystems")["systems"]),
                      timeout=10, what="this system's address to be known")
        sent("other,stage", "named")
        fppd.wait_for(lambda: value() == "named", timeout=5, what="the command for its name, second in the list")
        sent("other,10.77.0.1", "addressed")
        fppd.wait_for(lambda: value() == "addressed", timeout=5, what="the command for its address")
        sent("other,another", "nobody")
        sent("other,stage", "last")
        fppd.wait_for(lambda: value() == "last", timeout=5, what="the command after the one for nobody")


def test_a_scheduled_command_can_go_to_other_hosts(fppd):
    """A scheduled FPP command marked multisyncCommand is sent to the hosts it
    names, when it runs.

    Regression: 7c87d463b, which added that to the schedule."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=FIRST, DisableFakeNetworkBridges="1")
    fppd.write("config/schedule.json", [entry(7, "12:00:05", "12:00:05", playlist="", command="Set Variable",
                                              args=ARGS, multisyncCommand=1, multisyncHosts=FIRST)])
    with UdpCapture(PORT, FIRST) as cap:
        fppd.start(fake_time=f"{YEAR}-06-10 12:00:00", tz=ZONE)
        fppd.wait_for(lambda: (FIRST, "Set Variable", ARGS) in commands(cap), timeout=20, interval=0.5,
                      what="the scheduled command to reach the remote")
