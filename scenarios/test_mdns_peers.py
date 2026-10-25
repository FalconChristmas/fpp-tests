"""fppd's mDNS (MDNSBackendAvahi.cpp) against a real avahi-daemon, with
another FPP player on the network and with the daemon restarted under it.

The `avahi` fixture (test_mdns.py) gives the run an avahi-daemon of its own.
The `peer` fixture is the other player: a network namespace of its own,
joined to this one by a veth pair (10.99.7.1 here, 10.99.7.2 there), where a
small responder announces "peerbox._fppd._udp" over mDNS and answers the
MultiSync pings sent to its address -- only those sent to it, not the
broadcasts, so it is found through mDNS or not at all.

Runs in Docker or under run-local.sh (the veth gives the run's own network
namespace an interface for mDNS).
"""

import os
import socket
import subprocess
import sys
import time

import pytest

from test_mdns import HOST, avahi, fppd_names  # noqa: F401 -- fixture

HERE = os.path.dirname(os.path.abspath(__file__))

# The peer: waits for its end of the veth, brings it up, then announces its
# _fppd._udp service twice a second and replies to the unicast pings it gets.
# Prints "ping <source>" for each, for the test to read.
RESPONDER = r"""
import socket, struct, subprocess, sys, time, select
sys.path.insert(0, sys.argv[1])
from multisync import ping_packet
from test_mdns import _name, _rr
sys.stdin.readline()
for cmd in (["ip", "link", "set", "lo", "up"], ["ip", "addr", "add", "10.99.7.2/24", "dev", "fppmd1"],
            ["ip", "link", "set", "fppmd1", "up", "multicast", "on"],
            ["ip", "route", "add", "224.0.0.0/4", "dev", "fppmd1"]):
    subprocess.run(cmd, check=True)
full = "peerbox._fppd._udp.local"
rrs = [_rr("_fppd._udp.local", 12, 1, 120, _name(full)),
       _rr(full, 33, 0x8001, 120, struct.pack("!HHH", 0, 0, 32320) + _name("peerbox.local")),
       _rr(full, 16, 0x8001, 120, b"\x04fpp1"),
       _rr("peerbox.local", 1, 0x8001, 120, socket.inet_aton("10.99.7.2"))]
answer = struct.pack("!HHHHHH", 0, 0x8400, 0, len(rrs), 0, 0) + b"".join(rrs)
mdns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
mdns.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
mdns.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
mdns.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton("10.99.7.2"))
mdns.bind(("", 5353))
ms = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
ms.bind(("10.99.7.2", 32320))
print("ready", flush=True)
next_announce = 0
while True:
    now = time.monotonic()
    if now >= next_announce:
        mdns.sendto(answer, ("224.0.0.251", 5353))
        next_announce = now + 0.5
    r, _, _ = select.select([ms], [], [], 0.1)
    if r:
        data, src = ms.recvfrom(2048)
        if data[:4] == b"FPPD" and data[4] == 0x04:
            print(f"ping {src[0]}", flush=True)
            ms.sendto(ping_packet("10.99.7.2", "peerbox"), (src[0], 32320))
"""


@pytest.fixture
def peer():
    """Another player at 10.99.7.2 in a network namespace of its own; yields
    the responder process (its stdout says which pings it answered)."""
    probe = subprocess.run(["unshare", "--net", "true"], capture_output=True)
    if probe.returncode:
        pytest.skip("cannot make a network namespace here: " + probe.stderr.decode(errors="replace").strip())
    subprocess.run(["ip", "link", "del", "fppmd0"], capture_output=True)
    p = subprocess.Popen(["unshare", "--net", sys.executable, "-I", "-c", RESPONDER, HERE],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        def ip(*a):
            r = subprocess.run(["ip", *a], capture_output=True, text=True)
            assert r.returncode == 0, f"ip {' '.join(a)}: {r.stderr}"
        ip("link", "add", "fppmd0", "type", "veth", "peer", "name", "fppmd1")
        ip("link", "set", "fppmd1", "netns", str(p.pid))
        ip("addr", "add", "10.99.7.1/24", "dev", "fppmd0")
        ip("link", "set", "fppmd0", "up", "multicast", "on")
        p.stdin.write("go\n")
        p.stdin.flush()
        assert p.stdout.readline().strip() == "ready", "the peer never came up"
        yield p
    finally:
        p.kill()
        p.wait()
        subprocess.run(["ip", "link", "del", "fppmd0"], capture_output=True)


def advertised(timeout):
    """Wait until fppd's own service (under the host name) is published;
    whether it was, and the names last seen beside it."""
    deadline = time.monotonic() + timeout
    while True:
        names = fppd_names()
        if HOST in names or time.monotonic() >= deadline:
            return HOST in names, names
        time.sleep(0.5)


def systems(fppd):
    return {s["address"]: s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if not s.get("local")}


def test_a_player_announced_over_mdns_is_pinged_and_listed(peer, avahi, fppd):
    """A player announcing _fppd._udp on the network is found: fppd resolves
    it, sends a ping to its address (not only the broadcast one), and lists
    it in multiSyncSystems under the host name its reply gives.

    Regression: 0f8c5b741 (the discovery). Without mDNS fppd found other
    players only by its broadcast pings, which do not cross a router or a
    Wi-Fi AP that drops broadcasts -- here, which the peer ignores."""
    fppd.settings(LogLevel_Sync="debug")
    fppd.start()
    fppd.wait_for(lambda: "10.99.7.2" in systems(fppd), timeout=30, interval=0.5,
                  what="the peer to be listed in multiSyncSystems")
    assert systems(fppd)["10.99.7.2"].get("hostname") == "peerbox", systems(fppd)["10.99.7.2"]
    assert "MDNS discovered new host 10.99.7.2" in fppd.log(), fppd.tail()


def test_the_service_is_advertised_again_after_avahi_restarts(peer, avahi, fppd):
    """avahi-daemon restarted under a running fppd (as an upgrade or a
    "systemctl restart" does): within seconds fppd advertises _fppd._udp
    again, and no mDNS warning is left up.

    Regression: 81c9e4e80. An Avahi client does not reconnect: once the
    daemon went, the advertisement and both browsers were gone until fppd
    itself restarted, and the warning the failure raised never cleared."""
    fppd.settings(LogLevel_Sync="info")
    fppd.start()
    ok, names = advertised(30)
    assert ok, f"precondition: fppd advertises its service: {names}\n{fppd.tail()}"
    avahi.terminate()
    avahi.wait(10)
    for leftover in ("/run/avahi-daemon/pid", "/run/avahi-daemon/socket"):
        try:
            os.unlink(leftover)
        except FileNotFoundError:
            pass
    again = subprocess.Popen(["avahi-daemon", "--no-rlimits", "--no-chroot"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok, names = advertised(20)
        assert ok, f"fppd's service is not advertised after avahi-daemon restarted: {names}\n{fppd.tail()}"
        assert "Avahi client connected after" in fppd.log(), fppd.tail()
        warnings = [w.get("message", "") if isinstance(w, dict) else str(w) for w in fppd.get("/fppd/warnings")]
        assert not [w for w in warnings if "mDNS" in w or "Avahi" in w], warnings
    finally:
        again.terminate()
        try:
            again.wait(10)
        except subprocess.TimeoutExpired:
            again.kill()
