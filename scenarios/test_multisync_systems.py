"""MultiSync discovery: what fppd lists in /fppd/multiSyncSystems from the
ping packets it receives, and how it answers a discover ping.

A ping names the address it was sent from in its own IP field, and fppd
records the system under that, so pings sent over loopback stand in for
devices anywhere on a network.

6046beef2, 0de9217e3 and 5b25d5a08 were each checked by reversing that
commit's change to MultiSync.cpp on the current tree: its scenario fails.
"""

import contextlib
import os
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
    the list, not one channel high (5b25d5a08). The backfill itself is
    6d6db439f: before it such a controller was listed with no ranges."""
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


def test_pings_that_arrive_while_the_main_loop_is_held_are_kept(fppd):
    """Pings from 1000 systems that arrive while fppd's main loop is held
    up -- an output reload, a large show's players all coming up at once --
    are all there for it when it gets back to them: every system is listed.

    Regression: 884431655. The receive socket kept the kernel's default
    buffer, 212992 bytes, about 166 datagrams at ~1.3 KB each whatever
    their size, so the rest of a burst was dropped in the kernel. Here
    fppd is stopped (SIGSTOP) while the burst goes out.

    On a host where net.core.rmem_max is still the kernel's default (fppinit
    raises it on a player; a stock Docker host leaves it), it also needs
    1ef7def6d: before it the 1 MB request was clamped to the default, and
    667 of the 1000 pings were dropped.
    """
    import signal
    fppd.start()
    count = 1000
    addresses = [f"10.40.{n // 250}.{n % 250 + 1}" for n in range(count)]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    os.kill(fppd.proc.pid, signal.SIGSTOP)
    try:
        for n, ip in enumerate(addresses):
            s.sendto(ping_packet(ip, f"burst-{n}"), ("127.0.0.1", PORT))
    finally:
        os.kill(fppd.proc.pid, signal.SIGCONT)
        s.close()
    wanted = set(addresses)

    def listed():
        return len(wanted & {r["address"] for r in remotes(fppd)})

    seen = []

    def settled():
        seen.append(listed())
        return len(seen) > 3 and seen[-1] == seen[-4]
    fppd.wait_for(settled, timeout=20, interval=0.5, what="the system list to settle")
    assert seen[-1] == count, f"{count - seen[-1]} of {count} systems' pings were dropped"


def _ddp_universe(start, count, n):
    return {"active": 1, "description": "", "id": 64001 + n, "startChannel": start + 1,
            "channelCount": count, "type": 5, "address": "127.0.0.1", "priority": 0,
            "monitor": 0, "deDuplicate": 0}


def test_ranges_too_long_for_a_ping_merge_the_closest_pair(fppd):
    """Output ranges that don't fit in a ping's 120-character field are
    merged, closest pair first, until they do: a short first range far from
    a long second one stays apart while ten ranges 1990 channels apart are
    joined. (Gaps of up to 1025 channels are joined before any of this.)

    Regression: a4ed6851d. The merge seeded its running end of range from
    the second range's length instead of the first's, so with a long second
    range the first pair always looked closest: the ping advertised
    0-104999 and claimed the 4990 channels between them.
    """
    universes = [_ddp_universe(0, 10, 0), _ddp_universe(5000, 100000, 1)]
    universes += [_ddp_universe(200000 + 2000 * k, 10, 2 + k) for k in range(10)]
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 220000,
        "universes": universes}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with contextlib.ExitStack() as stack:
        stack.enter_context(interface("10.77.0.1"))
        fppd.start()
        local = [s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s.get("local")]
        assert local and local[0]["channelRanges"].startswith("0-9,5000-104999,200000-200009,"), local
        cap = stack.enter_context(UdpCapture(PORT, "127.0.0.3"))
        send(ping_packet("10.20.30.45", "peer-f", discover=True), src="127.0.0.3")
        fppd.wait_for(lambda: [p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04"],
                      timeout=5, interval=0.1, what="a ping back")
        reply = next(p for _, _, _, p in cap.snapshot() if p[4:5] == b"\x04")
    ranges = reply[166:287].split(b"\0")[0].decode()
    assert len(ranges) <= 120, ranges
    assert ranges.startswith("0-9,5000-104999,"), f"the ping advertises {ranges}"


def test_an_external_address_that_is_not_ipv4_is_survived(fppd):
    """In a container, MultiSyncExternalIPAddress names the address fppd
    announces. One that isn't a dotted quad -- a host name -- doesn't stop
    fppd, which lists itself under it.

    Regression: a4ed6851d. The local system's address was split on dots
    and the first four parts read without checking there were four: a
    name with fewer dots read past the end of the parts (ASan: heap
    overflow at startup).
    """
    if not os.path.exists("/etc/fpp/container"):
        pytest.skip("MultiSyncExternalIPAddress is read only in a container")
    fppd.settings(MultiSyncExternalIPAddress="fpp.example")
    fppd.start()
    local = [s["address"] for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s.get("local")]
    assert "fpp.example" in local, local
    fppd.check_alive()


def test_twinkly_replies_are_probed_a_few_at_a_time(fppd):
    """Lights answering fppd's Twinkly discovery broadcast all at once are
    probed over HTTP a few at a time -- no more than the 4 in flight the
    periodic probes keep -- however many answer: 24 lights whose web servers
    take 1 s to answer never see more than 4 probes open at once, and all 24
    are probed.

    Regression: 4be58fb6a. Each reply started its HTTP probe on the spot,
    outside the in-flight cap: 24 replies, 24 probes at once (and a burst of
    datagrams claiming to be replies, as many as it named).
    """
    import sys
    import threading
    from fake_devices import DEV_IF, HOST_ADDR, HOST_IF, NETNS, _ip, device_network

    lights = [f"10.89.0.{i + 1}" for i in range(24)]
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "twinkly_held_replies.py")
    with device_network(["10.88.0.2"]) as run:
        # fppd sends its discovery to each interface's broadcast address
        for args, ns in ((("addr", "del", HOST_ADDR + "/24", "dev", HOST_IF), None),
                         (("addr", "add", HOST_ADDR + "/24", "brd", "+", "dev", HOST_IF), None),
                         (("route", "add", "10.89.0.0/16", "dev", HOST_IF), None),
                         (("addr", "add", "10.88.0.3/24", "brd", "+", "dev", DEV_IF), NETNS)):
            r = _ip(*args, ns=ns)
            assert r.returncode == 0, f"ip {' '.join(args)}: {r.stderr}"
        batch = "".join(f"addr add {a}/16 dev {DEV_IF}\n" for a in lights)
        r = subprocess.run(["ip", "-n", NETNS, "-batch", "-"], input=batch, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        proc = run(sys.executable, "-I", script, ",".join(lights), "1")
        lines = []

        def read():
            for line in proc.stdout:
                lines.append(line)
        threading.Thread(target=read, daemon=True).start()
        fppd.wait_for(lambda: "ready\n" in lines, what="the fake lights to listen")
        fppd.start()
        fppd.wait_for(lambda: "sent\n" in lines, timeout=30, what="fppd's Twinkly discovery broadcast")

        def probed():
            return {line.split()[1] for line in lines if line.startswith("probe ")} & set(lights)
        fppd.wait_for(lambda: len(probed()) == len(lights), timeout=60, interval=0.5,
                      what="every light to be probed")
    most = max([int(line.split()[1]) for line in lines if line.startswith("open ")], default=0)
    assert most <= 4, f"{most} probes of the lights open at once"


@contextlib.contextmanager
def second_address(address):
    """An extra address on loopback, to send pings from a source fppd doesn't
    take for loopback. Needs NET_ADMIN."""
    r = subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], capture_output=True, text=True)
    if r.returncode:
        pytest.skip(f"cannot add an address: {r.stderr.strip()}")
    try:
        yield
    finally:
        subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"], capture_output=True)


def test_a_ping_with_no_ip_field_is_listed_under_its_source_address(fppd):
    """A controller that leaves the IP field of its (non-discover) ping at
    0.0.0.0 is still listed, under the address the packet came from.

    Regression: b9e699e4c. Such a ping was taken for a discovery probe and
    the controller never appeared."""
    fppd.start()
    with second_address("10.99.1.7"):
        send(ping_packet("0.0.0.0", "no-ip-peer", version=3), src="10.99.1.7")
        s = wait_listed(fppd, "10.99.1.7")
    assert s["hostname"] == "no-ip-peer", s


def test_multisync_works_with_no_co_universes_file(fppd):
    """With no config/co-universes.json at all, MultiSync starts, lists a
    pinging peer and logs no error about the missing file.

    Regression: f05a1c711. The HTTP discovery at startup loaded the file
    without checking it was there, and the loader logged "JSON File
    .../co-universes.json does not exist" as an error on every player with
    no channel outputs configured."""
    assert not os.path.exists(os.path.join(fppd.media, "config", "co-universes.json"))
    fppd.start()
    send(ping_packet("10.20.30.60", "peer-nofile", version=3))
    wait_listed(fppd, "10.20.30.60")
    missing = [l for l in fppd.log().splitlines() if "co-universes.json does not exist" in l]
    assert not missing, missing
