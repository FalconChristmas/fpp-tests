"""fppd's answer to an Art-Net ArtPoll: the ArtPollReply a lighting console
or controller discovery tool reads to learn which universes fppd takes in.

fppd broadcasts the reply on each of its interfaces other than loopback, so
it is read off that interface with a packet socket (capture.py); with no
such interface (run-local.sh) there is nothing to see, and the tests skip.
"""

import json
import socket
import subprocess
import time

import pytest

from capture import UdpCapture
from packets import ARTNET_PORT


def artpoll():
    """An ArtPoll (OpPoll 0x2000), protocol 14, no flags."""
    return b"Art-Net\x00" + bytes([0x00, 0x20, 0x00, 14, 0x00, 0x00])


def an_interface():
    """A non-loopback interface with an IPv4 address that is up, or None."""
    out = subprocess.run(["ip", "-j", "-4", "addr", "show", "up"], capture_output=True, text=True)
    try:
        links = json.loads(out.stdout or "[]")
    except ValueError:
        return None
    for link in links:
        if link.get("ifname", "lo") != "lo" and not link["ifname"].startswith("usb") and link.get("addr_info"):
            return link["ifname"]
    return None


def artnet_inputs(*universes):
    """ci-universes.json: one Art-Net input universe per number."""
    return {"channelInputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512 * len(universes),
        "universes": [{"active": 1, "id": u, "startChannel": 1 + 512 * i, "channelCount": 512,
                       "type": 3, "priority": 0, "address": ""} for i, u in enumerate(universes)]}]}


def poll_reply(fppd, iface):
    """Send fppd an ArtPoll and return the first ArtPollReply it sends."""
    with UdpCapture(ARTNET_PORT, iface=iface) as cap:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            def reply():
                s.sendto(artpoll(), ("127.0.0.1", ARTNET_PORT))
                time.sleep(0.3)
                for _, _, _, p in cap.snapshot():
                    if p[:8] == b"Art-Net\x00" and p[8:10] == bytes([0x00, 0x21]):
                        return p
                return None
            return fppd.wait_for(reply, timeout=15, interval=0.2, what="an ArtPollReply")
        finally:
            s.close()


def started(fppd):
    iface = an_interface()
    if iface is None:
        pytest.skip("no interface other than loopback for fppd to answer an ArtPoll on")
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    return iface


def test_artpoll_reply_names_the_configured_artnet_universes(fppd):
    """The reply advertises the Art-Net input universes configured under
    Channel Inputs: two universes, 5 and 6, are two DMX ports (NumPorts 2,
    PortTypes 0xc0, GoodInput enabled) with SwIn 5 and 6, and the other two
    ports empty.

    Regression: 8457801f4. The reply was hard-coded to four ports, all on
    universe 0, whatever was configured, so a console polling fppd always
    saw universe 0.
    """
    fppd.write("config/ci-universes.json", artnet_inputs(5, 6))
    iface = started(fppd)
    p = poll_reply(fppd, iface)
    assert len(p) == 240, len(p)
    assert (p[172], p[173]) == (0, 2), f"NumPorts {p[172]},{p[173]}"
    assert list(p[174:178]) == [0xC0, 0xC0, 0, 0], f"PortTypes {p[174:178].hex()}"
    assert list(p[178:182]) == [0x08, 0x08, 0, 0], f"GoodInput {p[178:182].hex()}"
    assert list(p[186:190]) == [5, 6, 0, 0], f"SwIn {list(p[186:190])}"


def test_artpoll_reply_with_a_long_host_name(fppd):
    """With a 120-character host name, the reply carries its first 17
    characters as the short name and its first 63 as the long name, each
    ending in a NUL inside its field, and an empty node report after them.

    Regression: 1e042a38b. The name was strcpy()d into both fields
    unbounded: the short name ran into the long one with no NUL, and the
    long one ran on through the node report (and a long enough name past
    the end of the reply buffer on the stack).
    """
    name = "".join(f"{i:02d}-" for i in range(40))[:120]
    fppd.settings(HostName=name)
    fppd.write("config/ci-universes.json", artnet_inputs(1))
    iface = started(fppd)
    p = poll_reply(fppd, iface)
    short, long_, report = p[26:44], p[44:108], p[108:172]
    assert short == name[:17].encode() + b"\x00", f"ShortName {short!r}"
    assert long_ == name[:63].encode() + b"\x00", f"LongName {long_!r}"
    assert report == bytes(64), f"NodeReport {report!r}"
