"""Two players advertising the same System UUID (FalconChristmas/fpp#3195).

The UUID is what identifies a controller to FPP Connect and xLights. Two devices
sharing one cannot be told apart: one of them shows as unavailable and an upload
fails. In the field that has meant a support call and a hand-applied FPP_UUID
override on one of the pair.

MultiSync's ping carries the sender's UUID (v4), so fppd can see the collision
for itself. CheckForDuplicateUUID() then asks scripts/get_uuid for a new
identity and applies it to the running process, so no restart is needed and no
banner is left behind.

Regression: d4d4007.  Before it, nothing noticed the collision: both controllers
kept the same UUID indefinitely, and the only fix was an override set by hand.

The peer is a network namespace of its own, joined to this one by a veth pair
(10.99.7.1 here, 10.99.7.2 there), which answers MultiSync pings with whatever
UUID the test tells it to. Skips where unshare cannot make a namespace.

The override is used as the identity source so that regeneration rewrites the
scenario's own media settings file: the generated source would write
/etc/fpp/fpp_uuid, which lives outside the per-test media directory.
"""

import os
import socket
import subprocess
import sys
import time

import pytest

from multisync import ping_packet

HERE = os.path.dirname(os.path.abspath(__file__))

# Answers any MultiSync ping with a ping of its own carrying the UUID it was
# given, so fppd lists a second device that claims this player's identity.
RESPONDER = r"""
import select, socket, subprocess, sys
sys.path.insert(0, sys.argv[1])
from multisync import ping_packet
uuid = sys.argv[2]
for cmd in (["ip", "link", "set", "lo", "up"],
            ["ip", "addr", "add", "10.99.7.2/24", "dev", "fpdu1"],
            ["ip", "link", "set", "fpdu1", "up", "multicast", "on"],
            ["ip", "route", "add", "224.0.0.0/4", "dev", "fpdu1"]):
    subprocess.run(cmd, check=True)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("", 32320))
s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
             socket.inet_aton("239.70.80.80") + socket.inet_aton("10.99.7.2"))
s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton("10.99.7.2"))
print("ready", flush=True)
while True:
    r, _, _ = select.select([s], [], [], 0.2)
    if not r:
        continue
    data, src = s.recvfrom(2048)
    if data[:4] != b"FPPD" or data[4] != 0x04:
        continue
    s.sendto(ping_packet("10.99.7.2", "peerbox", uuid=uuid), (src[0], 32320))
"""


@pytest.fixture
def peer():
    """A player at 10.99.7.2 that will claim the UUID it is given."""
    procs = []

    def make(uuid):
        if subprocess.run(["unshare", "--net", "true"], capture_output=True).returncode:
            pytest.skip("cannot make a network namespace here")
        subprocess.run(["ip", "link", "del", "fpdu0"], capture_output=True)
        p = subprocess.Popen(["unshare", "--net", sys.executable, "-I", "-c", RESPONDER, HERE, uuid],
                             stdout=subprocess.PIPE, text=True)
        procs.append(p)

        def ip(*a):
            r = subprocess.run(["ip", *a], capture_output=True, text=True)
            assert r.returncode == 0, f"ip {' '.join(a)}: {r.stderr}"

        ip("link", "add", "fpdu0", "type", "veth", "peer", "name", "fpdu1")
        ip("link", "set", "fpdu1", "netns", str(p.pid))
        ip("addr", "add", "10.99.7.1/24", "dev", "fpdu0")
        ip("link", "set", "fpdu0", "up", "multicast", "on")
        assert p.stdout.readline().strip() == "ready", "the peer never came up"
        return p

    try:
        yield make
    finally:
        for p in procs:
            p.kill()
            p.wait()
        subprocess.run(["ip", "link", "del", "fpdu0"], capture_output=True)


def uuid_of(fppd):
    return fppd.get("/system/info")["uuid"]


def warnings(fppd):
    return [w for w in fppd.get("/fppd/warnings") if "UUID" in w]


def settings_uuid(fppd):
    """The FPP_UUID line as fppd's settings file now has it."""
    with open(os.path.join(fppd.media, "settings")) as f:
        for line in f:
            k, _, v = line.partition("=")
            if k.strip() == "FPP_UUID":
                return v.strip().strip('"')
    return None


def test_a_peer_claiming_this_uuid_makes_fppd_replace_its_own(peer, fppd):
    """A device advertising our UUID is a duplicate: fppd generates a new
    identity for itself and keeps running, without a restart and without
    leaving a warning up."""
    fppd.settings(LogLevel_Sync="info", FPP_UUID="AAAA1111BBBB2222")
    fppd.start()
    before = uuid_of(fppd)
    assert before == "AAAA1111BBBB2222", before

    peer(before)
    fppd.wait_for(lambda: uuid_of(fppd) != before, timeout=30, interval=0.25,
                  what="a new UUID once a duplicate appeared on the network")

    after = uuid_of(fppd)
    assert after != before, after
    assert "regenerated this device as" in fppd.log(), fppd.tail()
    assert not warnings(fppd), warnings(fppd)


def test_the_new_uuid_is_persisted_and_used_after_a_restart(peer, fppd):
    """The replacement is written back to the override, so the identity that
    the running fppd adopted is the one the next run starts with."""
    fppd.settings(LogLevel_Sync="info", FPP_UUID="CCCC3333DDDD4444")
    fppd.start()
    peer("CCCC3333DDDD4444")
    fppd.wait_for(lambda: uuid_of(fppd) != "CCCC3333DDDD4444", timeout=30, interval=0.25,
                  what="a new UUID once a duplicate appeared on the network")
    after = uuid_of(fppd)

    assert settings_uuid(fppd) == after, (settings_uuid(fppd), after)

    assert fppd.stop() == 0
    fppd.start()
    assert uuid_of(fppd) == after, uuid_of(fppd)
