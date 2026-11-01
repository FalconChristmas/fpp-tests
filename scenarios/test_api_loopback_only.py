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


def listening(host, port=32322):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.settimeout(2)
            s.connect((host, port))
            return True
    except OSError:
        return False


@pytest.mark.parametrize("mode", ["socket", "bind"])
def test_api_starts_without_ipv6(fppd, mode):
    """fppd starts on a box without IPv6 and serves its API on 127.0.0.1.
    "socket": the kernel has no IPv6 at all (socket(AF_INET6) fails with
    EAFNOSUPPORT). "bind": IPv6 is disabled on lo, so there is no ::1 to
    bind (EADDRNOTAVAIL).

    Regression: ea148c166. fppd always asked drogon to listen on [::1] as well
    as 127.0.0.1, and trantor aborts the process when a listener can't be
    created, so fppd died at startup with "Address family not supported"
    (errno 97) on an IPv6-less kernel."""
    import os
    import shims
    log = os.path.join(fppd.media, "tmp", "noipv6.log")
    fppd.start(preload=[shims.build("noipv6.c")],
               extra_env={"NOIPV6_MODE": mode, "NOIPV6_LOG": log})
    with open(log) as f:
        assert mode in f.read().split(), "the shim never refused anything, so this proves nothing"
    assert listening("127.0.0.1"), "fppd's API isn't on 127.0.0.1"
    fppd.wait_for(lambda: fppd.proc.poll() is None, timeout=1, what="fppd still running")


def test_api_listens_on_ipv6_loopback(fppd):
    """Where ::1 exists, fppd's API answers there too: Apache may resolve
    "localhost" to ::1 first, and the IPv6-less fallback above must not
    drop the [::1] listener on a box that has IPv6.

    Also 757b1e293: the backend listens on IPv6 as well as IPv4. Shown red
    with the [::1] listener not added."""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
    except OSError:
        pytest.skip("this machine has no ::1")
    fppd.start()
    assert listening("::1"), "fppd's API isn't on [::1]"
