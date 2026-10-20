"""MultiSync identities: the UUID each entry in /fppd/multiSyncSystems
carries, for devices that report one, devices that don't, and one device
seen at more than one address -- and the local system's own cape.

Devices that need a MAC live in the fake device network (fake_devices.py),
on a directly attached subnet, so the kernel's ARP table knows them. Pings
naming them are sent over loopback, as in test_multisync_systems.py.
"""

import json
import os
import socket
import subprocess
import time

from fake_devices import DEV_IF, NETNS, device_network
from multisync import ping_packet
from test_multisync_systems import interface, remotes, send, wait_listed


def device_mac():
    """The MAC every address in the fake device network answers ARP with,
    spelled as fppd spells a MAC identity (upper case, no separators)."""
    out = subprocess.run(["ip", "-n", NETNS, "-j", "link", "show", DEV_IF],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)[0]["address"].replace(":", "").upper()


def arp_complete(address):
    """Make the kernel resolve `address` (a datagram to it), and wait for a
    complete entry in /proc/net/arp -- what fppd reads a MAC from."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.sendto(b"x", (address, 9))
    s.close()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with open("/proc/net/arp") as f:
            for line in f.readlines()[1:]:
                ip, _, flags, *_ = line.split()
                if ip == address and int(flags, 16) & 0x2:
                    return
        time.sleep(0.1)
    raise AssertionError(f"{address} never got a complete ARP entry")


def uuid_of(fppd, address):
    return next((s["uuid"] for s in remotes(fppd) if s["address"] == address), None)


ESPS = 0xC3  # a controller type that is not fetched over HTTP


def test_a_device_with_no_uuid_is_identified_by_its_mac(fppd):
    """A device that reports no UUID, on a directly attached subnet, is
    identified as "MAC:" plus its hardware address; a real UUID it reports
    later replaces that stand-in, and a device the ARP table doesn't know
    (any address behind a router) is left with no identity.

    Feature: 39e8780d5."""
    with device_network(["10.88.0.2"]):
        arp_complete("10.88.0.2")
        mac = device_mac()
        fppd.start()
        send(ping_packet("10.88.0.2", "no-uuid", type_id=ESPS))
        send(ping_packet("10.20.30.80", "routed", type_id=ESPS))
        wait_listed(fppd, "10.88.0.2")
        wait_listed(fppd, "10.20.30.80")
        assert uuid_of(fppd, "10.88.0.2") == "MAC:" + mac, remotes(fppd)
        assert uuid_of(fppd, "10.20.30.80") in ("", "Unknown"), remotes(fppd)
        send(ping_packet("10.88.0.2", "no-uuid", type_id=ESPS, uuid="real-uuid-0001"))
        fppd.wait_for(lambda: uuid_of(fppd, "10.88.0.2") == "real-uuid-0001", timeout=5,
                      what="the real UUID to replace the MAC stand-in")


def test_one_device_at_two_addresses_keeps_one_identity(fppd):
    """A device listed at two addresses -- one where it reported its real
    UUID, one where only its MAC stand-in is known -- carries the real UUID
    at both. A hostname claimed by two different real UUIDs is two devices
    left on one name, and a stand-in under it is left alone.

    Regression: d70f31e83. A real UUID only ever reached the entry probed for
    it; the other address kept its MAC stand-in, so one device had two
    identities and was drawn (and counted) twice.
    """
    with device_network(["10.88.0.2", "10.88.0.3"]):
        for a in ("10.88.0.2", "10.88.0.3"):
            arp_complete(a)
        mac = device_mac()
        fppd.start()
        # one device, two addresses
        send(ping_packet("10.88.0.2", "twin", type_id=ESPS))
        wait_listed(fppd, "10.88.0.2")
        assert uuid_of(fppd, "10.88.0.2") == "MAC:" + mac, remotes(fppd)
        send(ping_packet("10.20.30.81", "twin", type_id=ESPS, uuid="twin-real-uuid"))
        wait_listed(fppd, "10.20.30.81")
        # two devices on one name
        send(ping_packet("10.20.30.82", "dupname", type_id=ESPS, uuid="dup-uuid-a"))
        send(ping_packet("10.20.30.83", "dupname", type_id=ESPS, uuid="dup-uuid-b"))
        wait_listed(fppd, "10.20.30.83")
        send(ping_packet("10.88.0.3", "dupname", type_id=ESPS))
        wait_listed(fppd, "10.88.0.3")
        time.sleep(0.5)
        got = {s["address"]: s["uuid"] for s in remotes(fppd)}
    assert got["10.20.30.81"] == "twin-real-uuid", got
    assert got["10.88.0.2"] == "twin-real-uuid", f"one device, two identities: {got}"
    assert got["10.88.0.3"] == "MAC:" + mac, got


CAPE = {"id": "fpp-test-cape", "name": "Test Cape 16", "version": "2.1",
        "vendor": {"name": "Test Vendor", "url": "https://example.com/"}}


def local_entry(fppd):
    return fppd.wait_for(lambda: next((s for s in fppd.get("/fppd/multiSyncSystems")["systems"]
                                       if s.get("local") and s["address"] == "10.77.0.1"), None),
                         timeout=10, what="the local system to be listed")


def test_the_local_system_lists_its_cape(fppd):
    """The local system's entry carries the cape this box has, read from
    tmp/cape-info.json (what the local /api/cape answers from).

    Regression: 7249ed9a2. Only remotes had capeInfo -- filled by probing
    their /api/cape -- and the local system is never probed, so the
    MultiSync page showed a cape for every box except the one serving it."""
    fppd.write("tmp/cape-info.json", CAPE)
    with interface("10.77.0.1"):
        fppd.start()
        s = local_entry(fppd)
    cape = s.get("capeInfo")
    assert cape, f"the local system has no capeInfo: {s}"
    assert cape.get("present") is True, cape
    assert (cape.get("id"), cape.get("name"), cape.get("version")) == \
        ("fpp-test-cape", "Test Cape 16", "2.1"), cape
    assert cape.get("vendor", {}).get("name") == "Test Vendor", cape


def test_a_local_system_without_a_cape_says_so(fppd):
    """With no tmp/cape-info.json the local entry says there is no cape
    (present false), which is an answer rather than "unknown".

    Regression: 7249ed9a2 (the local entry had no capeInfo at all)."""
    assert not os.path.exists(os.path.join(fppd.media, "tmp", "cape-info.json"))
    with interface("10.77.0.1"):
        fppd.start()
        s = local_entry(fppd)
    assert s.get("capeInfo") == {"present": False}, s
