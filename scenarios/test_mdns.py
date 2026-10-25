"""fppd's mDNS service names (MDNSBackendAvahi.cpp), against a real
avahi-daemon.

The `avahi` fixture starts a system bus and an avahi-daemon of their own in
the container; fppd's Avahi client finds them as it would on a player.
`Clash` stands in for another host on the network that publishes
"<host>._fppd._udp" too: it sends that service's records, pointing at port 9
on another box, as unsolicited mDNS answers five times a second, so avahi sees
a conflict whenever fppd probes or holds the name. `published()` reads back
what the daemon publishes, with avahi-browse.
"""

import datetime
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time

import pytest

HOST = socket.gethostname()
MDNS = ("224.0.0.251", 5353)


def _run(*cmd, timeout=10):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


@pytest.fixture
def avahi():
    """A dbus system bus and an avahi-daemon on it, for this test only."""
    if not shutil.which("avahi-daemon") or not shutil.which("avahi-browse"):
        pytest.skip("no avahi-daemon/avahi-utils in this image")
    if os.path.exists("/run/dbus/system_bus_socket"):
        pytest.skip("a system bus is already running here; not starting another")
    addrs = _run("ip", "-4", "-o", "addr", "show", "scope", "global").stdout
    if not addrs.strip():
        pytest.skip("no network interface with an IPv4 address for mDNS")
    os.makedirs("/run/dbus", exist_ok=True)
    bus = subprocess.Popen(["dbus-daemon", "--system", "--nofork", "--nopidfile"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    daemon = None
    try:
        deadline = time.monotonic() + 10
        while not os.path.exists("/run/dbus/system_bus_socket"):
            assert bus.poll() is None, "dbus-daemon --system exited"
            assert time.monotonic() < deadline, "the system bus never came up"
            time.sleep(0.1)
        daemon = subprocess.Popen(["avahi-daemon", "--no-rlimits", "--no-chroot"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Up once it has established its own host name.
        deadline = time.monotonic() + 20
        while _run("avahi-resolve-host-name", "-4", f"{HOST}.local").returncode != 0:
            assert daemon.poll() is None, "avahi-daemon exited"
            assert time.monotonic() < deadline, "avahi-daemon never resolved its own host name"
            time.sleep(0.25)
        yield daemon
    finally:
        for p in (daemon, bus):
            if p is not None and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
        for leftover in ("/run/dbus/system_bus_socket", "/run/avahi-daemon/pid",
                         "/run/avahi-daemon/socket"):
            try:
                os.unlink(leftover)
            except FileNotFoundError:
                pass


def _name(n):
    out = b""
    for label in n.rstrip(".").split("."):
        b = label.encode()
        out += bytes([len(b)]) + b
    return out + b"\0"


def _rr(name, rtype, rclass, ttl, rdata):
    return _name(name) + struct.pack("!HHIH", rtype, rclass, ttl, len(rdata)) + rdata


def _answer(instance, ttl):
    """An mDNS response publishing `instance`._fppd._udp.local at
    clash-box.local:9 (PTR, SRV, TXT and A; the unique ones with the
    cache-flush bit, as a responder sends them). ttl 0 is the goodbye."""
    full = f"{instance}._fppd._udp.local"
    rrs = [
        _rr("_fppd._udp.local", 12, 1, ttl, _name(full)),
        _rr(full, 33, 0x8001, ttl, struct.pack("!HHH", 0, 0, 9) + _name("clash-box.local")),
        _rr(full, 16, 0x8001, ttl, b"\x05clash"),
        _rr("clash-box.local", 1, 0x8001, ttl, socket.inet_aton("10.99.0.1")),
    ]
    return struct.pack("!HHHHHH", 0, 0x8400, 0, len(rrs), 0, 0) + b"".join(rrs)


class Clash:
    """Another host claiming "<host>._fppd._udp", until stop(), which sends
    the goodbye (ttl 0) so avahi drops it from its cache at once."""

    def __init__(self, instance=HOST):
        self.instance = instance
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        # avahi drops responses that don't come from port 5353.
        self.sock.bind(("", 5353))
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while not self.done.is_set():
            self.sock.sendto(_answer(self.instance, 120), MDNS)
            self.done.wait(0.2)

    def stop(self):
        if self.thread is None:
            return
        self.done.set()
        self.thread.join()
        self.thread = None
        for _ in range(3):
            self.sock.sendto(_answer(self.instance, 0), MDNS)
            time.sleep(0.2)
        self.sock.close()


def published(stype="_fppd._udp"):
    """{(instance name, port)} that avahi-browse resolves for `stype`."""
    out = _run("avahi-browse", "-t", "-p", "-r", "-k", stype, timeout=20).stdout
    found = set()
    for line in out.splitlines():
        f = line.split(";")
        if f[0] == "=" and len(f) >= 9:
            # -p escapes the name: "\032" is a space, "\035" a '#'.
            name = re.sub(r"\\(\d{3})", lambda m: chr(int(m.group(1))), f[3])
            found.add((name, int(f[8])))
    return found


def fppd_names(stype="_fppd._udp", port=32320):
    return {n for n, p in published(stype) if p == port}


def wait_for_names(want, timeout, stype="_fppd._udp", port=32320):
    """Wait until fppd's service is published under exactly `want`; returns
    when it was seen, and the last names seen either way."""
    deadline = time.monotonic() + timeout
    names = None
    while True:
        names = fppd_names(stype, port)
        if names == want:
            return True, names
        if time.monotonic() >= deadline:
            return False, names
        time.sleep(0.5)


def start_into_collision(fppd):
    """Start fppd while a Clash holds its host name. Once fppd's service has
    moved to "<host> #2", returns the Clash and when fppd logged the
    collision (time.time() seconds)."""
    fppd.settings(LogLevel_Sync="info")
    clash = Clash()
    try:
        fppd.start()
        ok, names = wait_for_names({f"{HOST} #2"}, 30)
        assert ok, f"fppd's service never moved to '{HOST} #2' on the clash: {names}\n{fppd.tail()}"
        m = re.search(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) .*MDNS service name collision",
                      fppd.log(), re.M)
        assert m, f"fppd logged no service name collision\n{fppd.tail()}"
        when = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S.%f").timestamp()
    except BaseException:
        clash.stop()
        raise
    return clash, when


def test_service_name_comes_back_once_the_collision_is_gone(avahi, fppd):
    """fppd takes "<host> #2" when another host holds its _fppd._udp name,
    and goes back to "<host>" (for _fppd._udp and _wled._tcp both) once that
    host has gone: the retry 30 s after the collision finds the name free.

    Regression: 3e67cdd6a. A service name collision switched to avahi's
    alternative name and never tried the real one again while fppd ran, so a
    collision that was only an echo of fppd's own records left it as
    "<host> #2" for good. (The later retries, at +2 min and +10 min, are not
    waited for here.)
    """
    clash, _ = start_into_collision(fppd)
    clash.stop()
    assert fppd_names() == {f"{HOST} #2"}
    ok, names = wait_for_names({HOST}, 60)
    assert ok, (f"fppd's service is still published as {names} a minute after the clash "
                f"went, not as '{HOST}'\n{fppd.tail()}")
    ok, wled = wait_for_names({HOST}, 10, stype="_wled._tcp", port=80)
    assert ok, f"_wled._tcp is published as {wled}, not as '{HOST}'"


def test_avahi_host_name_change_restores_the_service_name(avahi, fppd):
    """After a collision has put fppd on "<host> #2", avahi changing its own
    host name (avahi-set-host-name) puts fppd's service straight back on
    "<host>", long before the 30 s retry: fppd withdraws its services while
    the daemon re-registers its host records (AVAHI_CLIENT_S_REGISTERING) and
    registers them again under the host name when it is running again.

    Regression: 3e67cdd6a. fppd ignored the daemon's re-registration and kept
    "<host> #2"; a host name change is one of the times avahi can hear an
    echo of its old records as a collision.
    """
    clash, collided = start_into_collision(fppd)
    clash.stop()
    r = _run("avahi-set-host-name", f"{HOST}-renamed")
    assert r.returncode == 0, f"avahi-set-host-name failed: {r.stderr}"
    # Back within 25 s of the collision (by fppd's log, same clock as ours)
    # can't be the 30 s retry.
    ok, names = wait_for_names({HOST}, collided + 25 - time.time())
    assert ok, (f"fppd's service is still published as {names} after avahi's host name "
                f"changed, not as '{HOST}'\n{fppd.tail()}")


def test_a_lasting_collision_keeps_the_alternative_name(avahi, fppd):
    """While the other host keeps the name, the 30 s retry loses to it again
    and fppd is published as "<host> #2" again, not as "<host>".

    Not a regression check: before 3e67cdd6a there was no retry to lose.
    It covers the other half of that change, the one that leaves a real
    duplicate's name alone.

    Regression: 5dc7f543a (the collision half). A collision re-registered
    the same name, collided again, and looped; the service never moved to
    "<host> #2".
    """
    clash, _ = start_into_collision(fppd)
    try:
        fppd.wait_for(lambda: "MDNS retrying service name" in fppd.log(), timeout=60,
                      interval=0.5, what="fppd to retry its host name")
        fppd.wait_for(lambda: fppd.log().count(f"publishing as '{HOST} #2'") >= 2, timeout=20,
                      interval=0.25, what="the retry to collide again")
        ok, names = wait_for_names({f"{HOST} #2"}, 10)
        assert ok, f"after the retry lost, fppd's service is published as {names}\n{fppd.tail()}"
        # And it stays there.
        time.sleep(3)
        assert fppd_names() == {f"{HOST} #2"}
    finally:
        clash.stop()
