"""The type name MultiSync lists for a Raspberry Pi Zero 2 W."""

from multisync import ping_packet
from test_multisync_systems import send, wait_listed

ZERO_2_W = 0x0F  # kSysTypeFPPRaspberryPiZero2W


def test_pi_zero_2_w_has_a_type_name(fppd):
    """A ping announcing the Pi Zero 2 W system type (0x0F) is listed as a
    "Raspberry Pi Zero 2 W", not as an unknown type.

    Regression: fc4b300e8. The Zero 2 W had no system type of its own, so
    one on the network was listed with no model name."""
    fppd.start()
    send(ping_packet("10.20.30.60", "zero2w", version=3, type_id=ZERO_2_W))
    s = wait_listed(fppd, "10.20.30.60")
    assert s["type"] == "Raspberry Pi Zero 2 W", s
