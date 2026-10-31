"""MultiSync system types: the type fppd lists for a system in
/fppd/multiSyncSystems, from the type id a controller puts in its ping or
the board model this box reads for itself.

Pings are sent over loopback, as in test_multisync_systems.py; the board
model comes from a device tree served by fakesys.c.
"""

import os

import shims
from multisync import ping_packet
from test_multisync_systems import interface, remotes, send, wait_listed


def listed_type(fppd, address, type_id, hostname):
    send(ping_packet(address, hostname, version=3, type_id=type_id))
    s = wait_listed(fppd, address)
    return s["typeId"], s["type"]


def test_falcon_v5_ping_ids_are_named(fppd):
    """A Falcon v5 controller's ping carries type id 0x8a (F16v5), 0x8b
    (F48v5) or 0x8c (F32v5); each is listed under its own name.

    Regression: fd30ffed6. F16v5 was numbered 0x90, so the 0x8a an F16v5
    sends was "Unknown System Type". Feature: 221676a83 (the F48v5 and
    F32v5 ids; before it both were unknown).
    """
    fppd.start()
    got = {tid: listed_type(fppd, f"10.20.31.{tid & 0xff}", tid, f"falcon-{tid:x}")
           for tid in (0x8a, 0x8b, 0x8c)}
    assert got == {0x8a: (0x8a, "Falcon F16v5"),
                   0x8b: (0x8b, "Falcon F48v5"),
                   0x8c: (0x8c, "Falcon F32v5")}, got


def test_newer_experience_ping_ids_are_named(fppd):
    """Pings with the type ids of the newer Experience-based controllers,
    0xa5 to 0xa7, are listed as the LOR Aurora Core 16, the YPS Vivid 8 and
    the Genius Pixel Link 4.

    Feature: b5f4ac359. Before it the three ids were "Unknown System Type".
    (The 0xa6 name was later corrected from "VIDID" to "VIVID".)
    """
    fppd.start()
    got = {tid: listed_type(fppd, f"10.20.32.{tid & 0xff}", tid, f"genius-{tid:x}")
           for tid in (0xa5, 0xa6, 0xa7)}
    assert got == {0xa5: (0xa5, "LOR AURORA CORE 16"),
                   0xa6: (0xa6, "YPS VIVID 8"),
                   0xa7: (0xa7, "Genius PIXEL LINK 4")}, got


def test_a_later_0_0_range_does_not_wipe_the_advertised_one(fppd):
    """A system that advertised channel ranges keeps them when a later
    update for it says only "0-0" (what an HTTP probe or an older ping
    reports when it knows no ranges); a real new range still replaces them.

    Regression: fd30ffed6. Every update replaced the ranges, so a "0-0" one
    wiped what the system had advertised.
    """
    fppd.start()
    send(ping_packet("10.20.33.1", "ranged", version=3, type_id=0xC3, ranges="0-511"))
    assert wait_listed(fppd, "10.20.33.1")["channelRanges"] == "0-511"
    send(ping_packet("10.20.33.1", "ranged", version=3, type_id=0xC3, ranges="0-0"))
    send(ping_packet("10.20.33.2", "marker", version=3, type_id=0xC3))
    wait_listed(fppd, "10.20.33.2")
    s = next(r for r in remotes(fppd) if r["address"] == "10.20.33.1")
    assert s["channelRanges"] == "0-511", s
    send(ping_packet("10.20.33.1", "ranged", version=3, type_id=0xC3, ranges="512-1023"))
    fppd.wait_for(lambda: next(r for r in remotes(fppd) if r["address"] == "10.20.33.1")["channelRanges"]
                  == "512-1023", timeout=5, interval=0.1, what="a real new range to replace the old one")


def test_a_compute_module_5_is_listed_as_a_pi_5(fppd):
    """On a Raspberry Pi Compute Module 5 (device-tree model "Raspberry Pi
    Compute Module 5 Rev 1.0") the local system is a Raspberry Pi 5 -- the
    type it then announces in its pings -- not FPP on unknown hardware.

    Regression: 76225b7be. Only "Raspberry Pi 5" models were matched.
    """
    tree = os.path.join(fppd.media, "fakesys", "devicetree")
    fppd.write("fakesys/devicetree/model", "Raspberry Pi Compute Module 5 Rev 1.0\0")
    with interface("10.77.0.1"):
        fppd.start(preload=[shims.build("fakesys.c")],
                   extra_env={"FAKESYS": f"/sys/firmware/devicetree/base={tree}"})
        s = fppd.wait_for(lambda: next((s for s in fppd.get("/fppd/multiSyncSystems")["systems"]
                                        if s.get("local") and s["address"] == "10.77.0.1"), None),
                          timeout=10, what="the local system to be listed")
    assert s["model"] == "Raspberry Pi Compute Module 5 Rev 1.0", s
    assert s["type"] == "Raspberry Pi 5", s


def test_genius_pro_and_generic_genius_ping_ids_are_named(fppd):
    """Pings with type ids 0xa3, 0xa4 and 0xaf are listed as the Genius PRO
    16, the Genius PRO 32 and a Genius Controller.

    Feature: ba86815ce. Before it the three ids were "Unknown System Type".
    """
    fppd.start()
    got = {tid: listed_type(fppd, f"10.20.33.{tid & 0xff}", tid, f"genius-pro-{tid:x}")
           for tid in (0xa3, 0xa4, 0xaf)}
    assert got == {0xa3: (0xa3, "Genius PRO 16"),
                   0xa4: (0xa4, "Genius PRO 32"),
                   0xaf: (0xaf, "Genius Controller")}, got
