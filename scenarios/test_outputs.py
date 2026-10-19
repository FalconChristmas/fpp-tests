"""Channel outputs: what reaches the network, and what config reloads do to it.

Outputs point at 127.0.0.1 and a udp.Listener counts what arrives. Test mode
keeps channel data flowing at a steady rate while a scenario saves configs.
"""

import time

import shims
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


def test_controller_that_comes_up_late_gets_the_show(fppd):
    """A controller that is off when the show starts is dropped from the
    output with a warning once its pings fail, and picked back up -- data
    flowing, warning gone -- once it answers again, without any reload.
    (fppd pings every 15 s and drops a host after two failed pings and a
    failed HTTP probe, so this takes a minute or so.)"""
    import subprocess

    from ddp import DdpReceiver
    from fseq import unique_frames
    from show import CHANNELS, ddp_output, install

    address = "10.77.0.2"   # nothing answers here until the test adds it

    def host_warnings():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                if w.get("id") == 27]

    frames = unique_frames(4000, CHANNELS)  # 200 s, longer than the test
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        config = ddp_output(CHANNELS, address=address)
        config["channelOutputs"][0]["universes"][0]["monitor"] = 1
        fppd.write("config/co-universes.json", config)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(host_warnings, timeout=120, interval=1,
                      what="fppd to give up on the unreachable controller")
        try:
            subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], check=True)
            up = time.monotonic()
            assert rx.wait_frames(20, timeout=40, since=up), \
                "the controller came up but fppd never sent it anything"
            fppd.wait_for(lambda: not host_warnings(), timeout=40, interval=1,
                          what="the unreachable-controller warning to clear")
            latest = rx.last()[:CHANNELS]
            assert latest in frames, "the late controller got data that is not the show"
        finally:
            subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"])


def test_controllers_that_answer_stay_up_when_the_ping_thread_is_late(fppd):
    """Controllers that answer their pings stay in the output and raise no
    unreachable-controller warning, even when fppd's ping thread only gets
    to their replies after their timeout. slowping.so holds the thread up
    400 ms after each wake-up, as a name lookup with no reachable DNS
    (1705b8e89 moved those onto it) or a busy single-core board does, so a
    burst of replies is always waiting by the time it reads. Four
    controllers on loopback answer every ping, over the three pings at
    startup and the first periodic one 15 s later.

    Regression: 32f043984. Each pass of the ping thread read one reply and
    then timed out every other pending ping (5c1ef6c76): the first host was
    credited, the rest counted a lost ping, and three in a row took a
    controller that was up out of the output with warning 27.
    """
    addresses = [f"127.0.0.{n}" for n in range(2, 6)]
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1,
        "channelCount": 3 * len(addresses),
        "universes": [{"active": 1, "description": f"controller {a}", "id": 64001,
                       "startChannel": 1 + 3 * i, "channelCount": 3, "type": 5,
                       "address": a, "priority": 0, "monitor": 1, "deDuplicate": 0}
                      for i, a in enumerate(addresses)],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("slowping.c")])

    def host_warnings():
        return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])
                if w.get("id") == 27]

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert not host_warnings(), f"controllers that answer were dropped: {host_warnings()}"
        time.sleep(0.5)
    lost = [line for line in fppd.log().splitlines() if "Could not ping host" in line]
    assert not lost, "pings that were answered counted as lost:\n" + "\n".join(lost[:10])
