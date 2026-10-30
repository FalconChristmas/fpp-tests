"""Interfaces that hold an address but are down: fppd announces itself only
on interfaces that are up and running -- its MultiSync pings, sent to each
interface's broadcast address, and its Art-Net ArtPollReply, one per
interface naming that interface's address.

The down interface is a dummy one with an address and its link left down.
"""

import contextlib
import socket
import subprocess
import time

import pytest

from capture import UdpCapture
from multisync import PORT, ping_packet
from packets import ARTNET_PORT
from test_artpoll import an_interface, artnet_inputs, artpoll
from test_multisync_systems import send

DOWN_ADDR = "10.78.0.1"
DOWN_BCAST = "10.78.0.255"


@contextlib.contextmanager
def down_interface():
    """A dummy interface holding DOWN_ADDR/24, never brought up."""
    def ip(*args):
        return subprocess.run(["ip", *args], capture_output=True, text=True)
    r = ip("link", "add", "fpptestdn", "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        ip("addr", "add", DOWN_ADDR + "/24", "brd", DOWN_BCAST, "dev", "fpptestdn")
        yield "fpptestdn"
    finally:
        ip("link", "del", "fpptestdn")


def test_multisync_pings_skip_a_down_interface(fppd):
    """A discover ping makes fppd broadcast its own ping on each of its
    interfaces: on the up one (eth0 here) it goes to that interface's
    broadcast address, and nothing goes to the down interface's: none is
    seen leaving (a send to its broadcast address is routed out of the up
    interface), and the log has no failed send.

    Regression: f74da4e0f. Every interface with an IPv4 address was used,
    up or not: fppd sent its pings to the down interface's broadcast
    address too (routed out of the up interface, or failing outright).
    """
    up = an_interface()
    if up is None:
        pytest.skip("no interface other than loopback for fppd to broadcast on")
    fppd.settings(MultiSyncEnabled="1")
    with down_interface(), UdpCapture(PORT, iface=up) as cap:
        fppd.start()
        time.sleep(1)
        send(ping_packet("10.20.30.45", "peer-f", discover=True))
        fppd.wait_for(lambda: [p for _, _, d, p in cap.snapshot() if p[4:5] == b"\x04" and d != DOWN_BCAST],
                      timeout=10, interval=0.2, what="fppd's own ping on the up interface")
        time.sleep(1)
        to_down = [(s, d) for _, s, d, p in cap.snapshot() if d == DOWN_BCAST]
    assert not to_down, f"pings were sent to the down interface's broadcast address: {to_down}"
    failed = [l for l in fppd.log().splitlines() if "Unable to send packet" in l]
    assert not failed, failed


def test_artpoll_reply_skips_a_down_interface(fppd):
    """The ArtPollReply fppd broadcasts names the up interface's address and
    not the down interface's.

    Regression: f74da4e0f. A reply went out for every interface with an
    IPv4 address, so a console was also told to reach fppd at the address
    of an interface that was down.
    """
    up = an_interface()
    if up is None:
        pytest.skip("no interface other than loopback for fppd to answer an ArtPoll on")
    fppd.write("config/ci-universes.json", artnet_inputs(1))
    fppd.settings(DisableFakeNetworkBridges="1")
    with down_interface(), UdpCapture(ARTNET_PORT, iface=up) as cap:
        fppd.start()
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            def replies():
                s.sendto(artpoll(), ("127.0.0.1", ARTNET_PORT))
                time.sleep(0.5)
                return [p for _, _, _, p in cap.snapshot()
                        if p[:8] == b"Art-Net\x00" and p[8:10] == bytes([0x00, 0x21])]
            fppd.wait_for(replies, timeout=15, interval=0.2, what="an ArtPollReply")
            time.sleep(0.5)
            named = {socket.inet_ntoa(bytes(p[10:14])) for p in replies()}
        finally:
            s.close()
    assert DOWN_ADDR not in named, f"an ArtPollReply named the down interface's address: {named}"
    assert named, "no ArtPollReply named any address"
