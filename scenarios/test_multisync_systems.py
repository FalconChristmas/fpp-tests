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
    in it is dropped rather than stored.

    Regression: 561b26716, which added the UUID to ping v4. On its parent a
    remote's UUID was never read from the packet."""
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
    from -- describing itself, from one of its own addresses. (Where the
    only interface is loopback, which fppd never announces, a dummy one
    gives it an address to answer from.)"""
    fppd.settings(HostName="fpp-under-test")
    with contextlib.ExitStack() as stack:
        stack.enter_context(interface("10.77.0.1"))
        fppd.start()
        cap = stack.enter_context(UdpCapture(PORT, "127.0.0.3"))
        send(ping_packet("10.20.30.45", "peer-f", discover=True), src="127.0.0.3")
        fppd.wait_for(lambda: [p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04"],
                      timeout=5, interval=0.1, what="a ping back")
        reply = next(p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04")
        local = {s["address"] for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s.get("local")}
    said = ".".join(str(b) for b in reply[15:19])
    assert said in local, f"the answer gives address {said}, not one of this box's: {local}"
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


def test_remote_info_of_the_wrong_shape_is_survived(fppd):
    """fppd fetches each FPP remote's /api/system/info and /api/cape over
    HTTP, in a curl callback on its main loop. A remote whose replies have
    fields of the wrong type ({"Platform": {}}) keeps fppd running, and the
    fields that are well-formed are still stored.

    Regression: c8ccf32a0. The fields were read with asString() and
    friends: Json::LogicError on the first one with the wrong type reached
    the event loop and std::terminate ended fppd.

    Also covers 6158df3fb: fppd fetches a remote's system info and cape and
    lists them with the remote.
    """
    from fake_devices import fake_devices, page
    remote = "10.88.0.2"
    with fake_devices({remote: {
        "/": page("<html></html>"),
        "/api/system/info": page({"Platform": {}, "HostDescription": "fake-desc",
                                  "channelOutputsEnabled": "maybe", "IPs": [1, remote]}),
        "/api/cape": page({"name": {}, "id": "fake-cape", "sendStats": [1]}),
    }}):
        fppd.start()
        send(ping_packet(remote, "fake-remote", type_id=0x01, mode=0x08))
        wait_listed(fppd, remote)
        s = fppd.wait_for(lambda: next((r for r in remotes(fppd) if r["address"] == remote
                                        and "capeInfo" in r), None),
                          timeout=40, interval=0.5, what="the remote's info to be fetched")
    assert s.get("systemInfo", {}).get("HostDescription") == "fake-desc", s


def test_a_burst_of_discover_pings_gets_one_answer(fppd):
    """Discover pings that arrive together are answered together: fifty
    from one asker, back to back, get it a handful of pings back, not one
    each.

    Regression: fa17e56f9. Each discover ping was answered on the spot,
    after sleeping up to 6 ms on the main loop, with a broadcast ping and a
    unicast ping to the asker: fifty pings back here, and a steady stream of
    discover pings from anyone on the LAN held the main loop (and the
    output it feeds) in the receive loop.
    """
    with contextlib.ExitStack() as stack:
        stack.enter_context(interface("10.77.0.1"))
        fppd.start()
        cap = stack.enter_context(UdpCapture(PORT, "127.0.0.3"))
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.bind(("127.0.0.3", 0))
        packet = ping_packet("10.20.30.45", "peer-f", discover=True)
        for _ in range(50):
            s.sendto(packet, ("127.0.0.1", PORT))
        s.close()
        fppd.wait_for(lambda: [p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04"],
                      timeout=5, interval=0.1, what="a ping back")
        time.sleep(2)
        answers = sum(1 for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04")
    assert answers <= 5, f"{answers} pings back for one burst of discover pings"


def test_the_remote_system_list_is_bounded(fppd):
    """Pings naming more systems than any show has -- 2100 -- leave the
    list at its cap of 2048, with the newest kept and the one seen longest
    ago given up.

    Regression: 304751f0e. Every ping with a new address added a system,
    pruned only after two hours: the list (and the main-loop work that walks
    it) grew with whatever the network sent.
    """
    fppd.start()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for n in range(2100):
        s.sendto(ping_packet(f"10.30.{n // 250}.{n % 250 + 1}", f"peer-{n}"), ("127.0.0.1", PORT))
        if n % 100 == 99:
            time.sleep(0.02)
    s.close()
    last = f"10.30.{2099 // 250}.{2099 % 250 + 1}"
    wait_listed(fppd, last, timeout=10)
    time.sleep(1)
    listed = len(remotes(fppd))
    assert listed <= 2048, f"{listed} remote systems listed"


def test_sync_stats_are_kept_for_well_formed_senders_only(fppd):
    """Per-sender receive stats are kept only for senders of well-formed
    MultiSync packets, and for no more than 1024 of them: 7 bytes of junk
    from 50 addresses add none, and pings from 1100 addresses add 1024.

    Regression: 304751f0e. A stats entry was made for any datagram of 7
    bytes or more from a new source, before the FPPD header was checked,
    and never freed.
    """
    fppd.start()
    junk = [f"127.0.1.{n}" for n in range(1, 51)]
    senders = [f"127.0.{2 + n // 250}.{n % 250 + 1}" for n in range(1100)]
    packet = ping_packet("10.20.30.50", "peer-g")
    for i, src in enumerate(junk + senders):
        send(b"JUNKJUN" if src in junk else packet, src=src)
        if i % 100 == 99:
            time.sleep(0.02)
    fppd.wait_for(lambda: any(s.get("sourceIP") == senders[0]
                              for s in fppd.get("/fppd/multiSyncStats")["systems"]),
                  timeout=10, what="the senders' stats")
    time.sleep(1)
    stats = fppd.get("/fppd/multiSyncStats")["systems"]
    from_junk = [s["sourceIP"] for s in stats if s.get("sourceIP") in junk]
    assert not from_junk, f"stats kept for {len(from_junk)} senders of junk"
    assert len(stats) <= 1024, f"stats kept for {len(stats)} senders"


def test_an_endless_reply_from_a_remote_is_cut_off(fppd):
    """A MultiSync remote whose web server streams an answer that never
    ends to fppd's fetch of its /api/system/info is hung up on once the
    answer reaches CurlManager's 16 MB cap, not after the whole 10 s
    timeout. The server counts what it got to send before fppd hung up.

    Regression: 56d07749e. Responses were held in memory without limit,
    bounded only by the timeout: fppd read for the full 10 s (about 40 MB
    here, far more on a fast LAN) from any device answering as a remote.
    """
    import os
    import sys
    import threading
    from fake_devices import device_network
    remote = "10.88.0.2"
    server = os.path.join(os.path.dirname(os.path.abspath(__file__)), "endless_device_server.py")
    with device_network([remote]) as run:
        p = run(sys.executable, "-I", server, str(40 * 1024 * 1024), remote)
        assert p.stdout.readline().strip() == "ready", "the endless device server did not start"
        closed = []
        threading.Thread(target=lambda: closed.extend(iter(p.stdout.readline, "")),
                         daemon=True).start()

        def info_read():
            return [int(c.split()[2]) for c in closed if c.startswith("closed /api/system/info ")]

        fppd.start()
        send(ping_packet(remote, "endless", type_id=0x01, mode=0x08))
        wait_listed(fppd, remote)
        fppd.wait_for(info_read, timeout=40, interval=0.2,
                      what="fppd to hang up on the endless system info")
    read = info_read()[0] // (1024 * 1024)
    assert read <= 20, f"fppd read {read} MB of the endless system info before hanging up"
