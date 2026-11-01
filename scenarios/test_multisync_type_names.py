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
