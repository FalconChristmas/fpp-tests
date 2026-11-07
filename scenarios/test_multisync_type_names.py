"""The type name MultiSync lists for the system types a ping can announce."""

import pytest

from multisync import ping_packet
from test_multisync_systems import send, wait_listed


@pytest.mark.parametrize("type_id, name", [
    (0xA0, "Genius Pixel 16"),
    (0xA1, "Genius Pixel 8"),
    (0xA2, "Genius Long Range"),
])
def test_experience_controller_types_have_names(fppd, type_id, name):
    """A ping announcing one of the Genius controller system types (0xA0 to
    0xA2) is listed under that model's name, not as an unknown type.

    Feature: c1090dd3c. Without a name for the type the system was listed
    as "Unknown System Type"."""
    fppd.start()
    ip = f"10.20.30.{type_id - 0x90}"
    send(ping_packet(ip, f"genius-{type_id:x}", version=3, type_id=type_id))
    s = wait_listed(fppd, ip)
    assert s["type"] == name, s


NAMES = {
    0x02: "Raspberry Pi A", 0x03: "Raspberry Pi B", 0x04: "Raspberry Pi A Plus",
    0x05: "Raspberry Pi B+", 0x06: "Raspberry Pi 2 B", 0x07: "Raspberry Pi 2 B v1.2+",
    0x08: "Raspberry Pi 3 B", 0x09: "Raspberry Pi 3 B+", 0x0A: "Raspberry Pi Zero",
    0x0B: "Raspberry Pi Zero W", 0x0C: "Raspberry Pi 3 A+", 0x0D: "Raspberry Pi 4",
    0x0E: "Raspberry Pi 5", 0x0F: "Raspberry Pi Zero 2 W",
    0x41: "BeagleBone Black", 0x42: "BeagleBone Black Wireless", 0x43: "BeagleBone Green",
    0x44: "BeagleBone Green Wireless", 0x45: "PocketBeagle",
    0x46: "SanCloud BeagleBone Enhanced", 0x47: "PocketBeagle2", 0x60: "Armbian", 0x70: "MacOS",
    0x80: "Falcon Controller", 0x81: "Falcon F16v2", 0x82: "Falcon F4v2_64Mb", 0x83: "Falcon F16v2R",
    0x84: "Falcon F4v2", 0x85: "Falcon F16v3", 0x86: "Falcon F4v3", 0x87: "Falcon F48",
    0x88: "Falcon F16v4", 0x89: "Falcon F48v4", 0x8A: "Falcon F16v5", 0x8B: "Falcon F48v5",
    0x8C: "Falcon F32v5",
    0xA3: "Genius PRO 16", 0xA4: "Genius PRO 32", 0xA5: "LOR AURORA CORE 16", 0xA6: "YPS VIVID 8",
    0xA7: "Genius PIXEL LINK 4", 0xAF: "Genius Controller", 0xC0: "Other Unknown System",
    0xC1: "xSchedule", 0xC2: "ESPixelStick-ESP8266", 0xC3: "ESPixelStick-ESP32", 0xC4: "Baldrick",
    0xFA: "Twinkly", 0xFB: "WLED", 0xFC: "DIYLEDExpress", 0xFD: "HinksPix", 0xFE: "AlphaPix",
    0xFF: "SanDevices",
}


def test_every_system_type_a_ping_can_announce_is_named(fppd):
    """Each model a ping can announce is listed under its own name, one system
    for each. A type number FPP doesn't know is "Unknown System Type"."""
    fppd.start()
    want = {**NAMES, 0xEE: "Unknown System Type"}
    for type_id in want:
        send(ping_packet(f"10.20.31.{type_id}", f"sys-{type_id:x}", version=3, type_id=type_id))
    bad = {}
    for type_id, name in want.items():
        s = wait_listed(fppd, f"10.20.31.{type_id}")
        if s["type"] != name:
            bad[hex(type_id)] = (s["type"], name)
    assert not bad, f"(listed, wanted): {bad}"
