"""MultiSync discovery: what fppd lists in /fppd/multiSyncSystems from the
ping packets it receives, and how it answers a discover ping.

A ping names the address it was sent from in its own IP field, and fppd
records the system under that, so pings sent over loopback stand in for
devices anywhere on a network.

6046beef2, 0de9217e3 and 5b25d5a08 were each checked by reversing that
commit's change to MultiSync.cpp on the current tree: its scenario fails.
"""

import contextlib
import socket
import subprocess
import time

import pytest

from capture import UdpCapture
from multisync import PORT, ping_packet


def send(packet, src="127.0.0.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((src, 0))
    s.sendto(packet, ("127.0.0.1", PORT))
    s.close()


def remotes(fppd):
    return [s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if not s.get("local")]


def wait_listed(fppd, address, timeout=5):
    return fppd.wait_for(lambda: next((s for s in remotes(fppd) if s["address"] == address), None),
                         timeout=timeout, interval=0.1, what=f"{address} to be listed")


def test_ping_lists_the_system(fppd):
    """A ping adds the system it describes, with what it says about itself;
    a later ping from the same system updates that entry, not a new one."""
    fppd.start()
    send(ping_packet("10.20.30.40", "peer-a", version=3, ver="9.9", model="Pi Test",
                     ranges="0-149,300-449"))
    s = wait_listed(fppd, "10.20.30.40")
    assert s["hostname"] == "peer-a", s
    assert s["version"] == "9.9", s
    assert s["model"] == "Pi Test", s
    assert s["channelRanges"] == "0-149,300-449", s
    send(ping_packet("10.20.30.40", "peer-a", version=3, ver="9.10", ranges="0-149"))
    fppd.wait_for(lambda: [r["version"] for r in remotes(fppd) if r["address"] == "10.20.30.40"] == ["9.10"],
                  timeout=5, interval=0.1, what="the entry to be updated in place")


def test_loopback_is_never_listed(fppd):
    """A ping that names a loopback address is this box finding itself, not
    a peer, and is not listed (6046beef2)."""
    fppd.start()
    for ip in ("127.0.0.1", "127.0.1.1"):
        send(ping_packet(ip, f"self-{ip}", version=3))
    send(ping_packet("10.20.30.41", "peer-b", version=3))
    wait_listed(fppd, "10.20.30.41")
    time.sleep(0.5)
    listed = [s["address"] for s in remotes(fppd)]
    assert not [a for a in listed if a.startswith("127.")], f"loopback listed: {listed}"


def test_link_local_entry_gives_way_to_the_routable_one(fppd):
    """A device that came up on a 169.254 address before DHCP answered is
    listed once it reports from its real address -- once, not twice -- and
    an older sender still announcing the link-local one doesn't bring the
    duplicate back (0de9217e3)."""
    fppd.start()
    uuid = "M-0123456789ab"
    send(ping_packet("169.254.7.8", "peer-c", uuid=uuid))
    wait_listed(fppd, "169.254.7.8")
    send(ping_packet("10.20.30.42", "peer-c", uuid=uuid))
    wait_listed(fppd, "10.20.30.42")
    time.sleep(0.5)
    send(ping_packet("169.254.7.8", "peer-c", uuid=uuid))
    time.sleep(0.5)
    mine = [s["address"] for s in remotes(fppd) if s["hostname"] == "peer-c"]
    assert mine == ["10.20.30.42"], f"peer-c listed at {mine}"


def test_ping_uuid_is_kept_only_when_printable(fppd):
    """A v4 ping's UUID identifies the device; one with control characters
    in it is dropped rather than stored."""
    fppd.start()
    send(ping_packet("10.20.30.43", "peer-d", uuid="abcd-1234"))
    send(ping_packet("10.20.30.44", "peer-e", uuid=b"ab\x01\x02cd"))
    assert wait_listed(fppd, "10.20.30.43")["uuid"] == "abcd-1234"
    assert wait_listed(fppd, "10.20.30.44")["uuid"] in ("", "Unknown")


@contextlib.contextmanager
def interface(address):
    """A dummy interface holding `address`: fppd describes itself in pings
    from its interfaces' addresses, and skips loopback, so with loopback
    alone it has nothing to send. Needs NET_ADMIN (run.sh and run-local.sh
    both have it)."""
    def ip(*args):
        return subprocess.run(["ip", *args], capture_output=True, text=True)
    r = ip("link", "add", "fpptest0", "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        ip("addr", "add", address + "/24", "dev", "fpptest0")
        ip("link", "set", "fpptest0", "up")
        yield
    finally:
        ip("link", "del", "fpptest0")


def test_discover_ping_is_answered(fppd):
    """A discover ping makes fppd ping back -- to the address it was sent
    from -- describing itself."""
    fppd.settings(HostName="fpp-under-test")
    with contextlib.ExitStack() as stack:
        stack.enter_context(interface("10.77.0.1"))
        fppd.start()
        cap = stack.enter_context(UdpCapture(PORT, "127.0.0.3"))
        send(ping_packet("10.20.30.45", "peer-f", discover=True), src="127.0.0.3")
        fppd.wait_for(lambda: [p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04"],
                      timeout=5, interval=0.1, what="a ping back")
        reply = next(p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04")
    assert reply[15:19] == bytes([10, 77, 0, 1]), f"the answer gives address {list(reply[15:19])}"
    assert reply[8] == 0, "the answer should be a plain ping, not another discover"
    assert reply[19:84].split(b"\0")[0] == b"fpp-under-test", reply[19:84]


def test_backfilled_ranges_are_zero_based(fppd):
    """A non-FPP controller that advertises no channel ranges gets them from
    this box's own outputs to it -- zero-based like every other range in
    the list, not one channel high (5b25d5a08)."""
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 1020,
        "universes": [
            {"active": 1, "description": "", "id": 1, "startChannel": 1, "size": 510,
             "type": 1, "address": "10.20.30.46", "priority": 0, "monitor": 0,
             "deDuplicate": 0, "channelCount": 510},
            {"active": 1, "description": "", "id": 2, "startChannel": 511, "size": 510,
             "type": 1, "address": "10.20.30.46", "priority": 0, "monitor": 0,
             "deDuplicate": 0, "channelCount": 510}]}]})
    fppd.start()
    send(ping_packet("10.20.30.46", "esps", version=3, type_id=0xC3, ranges=""))
    s = wait_listed(fppd, "10.20.30.46")
    assert s["channelRanges"] == "0-1019", s


def test_wrong_typed_output_universes_do_not_stop_startup(fppd):
    """The ranges above, and the HTTP discovery list, are read from
    co-universes.json at startup. A universe whose fields have the wrong
    JSON type is skipped there, not thrown on.

    Regression: 7701df72a. Before it fppd terminated on Json::LogicError
    before it finished starting."""
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "universes": [5, {"address": "10.20.30.47", "startChannel": "1", "channelCount": [510]},
                      {"address": ["x"], "startChannel": 1, "channelCount": 510}]}]})
    fppd.start()
    send(ping_packet("10.20.30.47", "esps2", version=3, type_id=0xC3))
    wait_listed(fppd, "10.20.30.47")
