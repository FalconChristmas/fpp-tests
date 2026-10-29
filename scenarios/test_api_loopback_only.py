"""fppd's own HTTP API (port 32322) is for this machine only: Apache proxies
/api to it for the network, so fppd listens on the loopback addresses and
nowhere else."""

import socket

import pytest


def non_loopback_address():
    """This machine's address on its outward interface (no packet is sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))
        addr = s.getsockname()[0]
    except OSError:
        addr = None
    finally:
        s.close()
    if not addr or addr.startswith("127."):
        pytest.skip("no non-loopback IPv4 address")
    return addr


def reachable(host, port=32322):
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


def test_api_port_is_not_reachable_from_the_network(fppd):
    """fppd's API answers on 127.0.0.1 and refuses a connection to this
    machine's own network address on the same port.

    Regression: 3c1669235. The API server bound every address (dual stack),
    so anyone on the LAN could reach fppd's API directly on port 32322,
    around Apache and the UI password in front of it (#2068)."""
    addr = non_loopback_address()
    fppd.start()
    assert reachable("127.0.0.1"), "fppd's API isn't on 127.0.0.1, so this proves nothing"
    assert not reachable(addr), f"fppd's API port 32322 accepts connections on {addr}"
