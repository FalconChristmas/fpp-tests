"""Which network interface a UDP output uses when none is configured, and
what it does when that interface's addresses change."""

import re
import subprocess
import time

import pytest

from test_output_protocols import output

IFACE = "ethtst0"   # starts with "e": the fallback prefers the ethernet-looking name


def ip(*args):
    return subprocess.run(["ip", *args], capture_output=True, text=True)


@pytest.fixture
def dummy_iface():
    """A dummy interface with an address, up, multicast on. Needs CAP_NET_ADMIN
    in fppd's network namespace (the test container, or run-local.sh's)."""
    ip("link", "del", IFACE)
    r = ip("link", "add", IFACE, "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    ip("addr", "add", "10.67.0.1/24", "dev", IFACE)
    ip("link", "set", IFACE, "multicast", "on", "up")
    try:
        yield IFACE
    finally:
        ip("link", "del", IFACE)


def write_output(fppd, interface=None):
    config = {"type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
              "universes": [output(0, 1, 1, 510)]}
    if interface:
        config["interface"] = interface
    fppd.write("config/co-universes.json", {"channelOutputs": [config]})
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="debug")


def chosen(fppd):
    found = re.findall(r"Interface +: (\S+)", fppd.log())
    assert found, "fppd did not dump the output's interface"
    return found[-1]


def test_an_output_with_no_interface_does_not_fall_back_to_loopback(fppd, dummy_iface):
    """A multicast E1.31 output with no interface set takes the first
    interface that is not loopback (an ethernet-looking name by preference),
    not "lo", which every machine lists first.

    Regression: 9890712b5. The fallback took the first interface getifaddrs
    listed, always loopback, so multicast went nowhere."""
    write_output(fppd)
    fppd.start()
    name = chosen(fppd)
    assert name != "lo", "the output fell back to the loopback interface"
    assert name.startswith("e"), f"interface chosen: {name}"


def test_a_renewed_address_does_not_re_ping_the_controllers(fppd, dummy_iface):
    """A new address arriving on an output interface that never went down (a
    DHCP renewal, a second address) is not "the interface came up": fppd does
    not log that or ping every controller from the thread that handles it.
    An interface that lost its address and got one back is up again.

    Regression: cb5326ef0. Every NEW_ADDR pinged the controllers and rebuilt
    the sockets, a renewal included, stalling the callback and the output
    behind a round of pings of controllers that were already known."""
    write_output(fppd, interface=dummy_iface)
    fppd.start()
    fppd.wait_for(lambda: "Interface        : " + dummy_iface in fppd.log(), timeout=10,
                  what="the output to be set up on the interface")
    now_up = f"UDP Interface {dummy_iface} now up"
    ip("addr", "add", "10.67.1.2/24", "dev", dummy_iface)
    time.sleep(3)
    assert now_up not in fppd.log(), "a second address on an up interface was treated as it coming up"
    # the control: really losing the addresses and getting one back is "up"
    ip("addr", "flush", "dev", dummy_iface)
    time.sleep(1)
    ip("addr", "add", "10.67.2.3/24", "dev", dummy_iface)
    fppd.wait_for(lambda: now_up in fppd.log(), timeout=10,
                  what="the interface to come back up after losing its addresses")
