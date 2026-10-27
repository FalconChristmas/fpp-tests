"""fppd's NetworkMonitor: the netlink socket it watches link and address
changes on, and the callbacks it passes them to."""

import ctypes
import os
import socket
import subprocess
import time

import plugin_build
import shims

SYS_pidfd_getfd = 438


def route_netlink_sockets(pid):
    """The NETLINK_ROUTE sockets process `pid` holds, as (fd, groups) with
    groups the multicast groups the socket is bound to (0 if unbound).
    Each socket is looked at through a copy of the descriptor
    (pidfd_getfd): /proc/net/netlink lists a netlink socket only once it is
    bound."""
    libc = ctypes.CDLL(None, use_errno=True)
    pidfd = os.pidfd_open(pid)
    held = []
    try:
        for fd in os.listdir(f"/proc/{pid}/fd"):
            try:
                if not os.readlink(f"/proc/{pid}/fd/{fd}").startswith("socket:["):
                    continue
            except FileNotFoundError:
                continue
            copy = libc.syscall(SYS_pidfd_getfd, pidfd, int(fd), 0)
            if copy < 0:
                continue
            s = socket.socket(fileno=copy)
            try:
                if s.family == socket.AF_NETLINK and s.proto == 0:  # NETLINK_ROUTE
                    held.append((int(fd), s.getsockname()[1]))
            finally:
                s.close()
    finally:
        os.close(pidfd)
    return sorted(held)


def start_failing(fppd, what):
    log = os.path.join(fppd.media, "tmp", "nlfail.log")
    fppd.start(preload=[shims.build("netlinkfail.c")], extra_env={"NLFAIL": what, "NLFAIL_LOG": log})
    # The control: the shim failed NetworkMonitor's call.
    assert os.path.exists(log) and what in open(log).read().split(), f"NetworkMonitor's {what}() was never failed"
    assert fppd.get("/fppd/status", timeout=5)["status_name"]


def test_a_netlink_socket_that_cannot_be_opened_is_not_watched(fppd):
    """With NetworkMonitor's netlink socket() failing, fppd starts and
    serves without trying to bind or watch the -1 it got back.

    Regression: 0266cc947. Init() logged the failure and went on: it bound
    -1 and registered a callback for it in the main loop's descriptor map,
    which epoll then refused ("Failed to add descriptor: -1")."""
    start_failing(fppd, "socket")
    log = fppd.log()
    assert "Could not create NETLINK socket" in log
    assert "Could not bind NETLINK socket" not in log
    assert "Failed to add descriptor: -1" not in log


def test_a_netlink_socket_that_cannot_be_bound_is_closed(fppd):
    """With NetworkMonitor's netlink bind() failing, fppd starts and
    serves, and holds no netlink route socket left over from it.

    Regression: 0266cc947. Init() logged the failure and went on: the
    unbound socket stayed open, watched by the main loop for events no
    one would send it."""
    start_failing(fppd, "bind")
    assert "Could not bind NETLINK socket" in fppd.log()
    assert route_netlink_sockets(fppd.proc.pid) == []


def test_netlink_route_socket_is_watched(fppd):
    """The control for the two above: started normally, fppd holds one
    netlink route socket, bound to link and IPv4 address changes."""
    fppd.start()
    held = route_netlink_sockets(fppd.proc.pid)
    assert [groups for fd, groups in held] == [0x11], held


def test_a_plugin_thread_adds_and_removes_callbacks_while_addresses_change(fppd):
    """A plugin thread registers a NetworkMonitor callback, removes it and
    frees what it captured, over and over, while addresses come and go on an
    interface and the main loop dispatches each change to the callbacks --
    some of them the plugin's, part-way through: fppd stays up with no
    sanitizer report, and the callbacks did run during it.

    Regression: 3ad8bd3d7. The callback map was walked, added to and erased
    with no lock, so a register or remove on another thread could corrupt it
    mid-walk; and removeCallback() returned while that callback was still
    running, so the caller freed what the callback was using."""
    iface = "fpptnm0"
    plugin_build.build_and_install(fppd, "netmonplugin.cpp", "fpp-netmon")
    subprocess.run(["ip", "link", "del", iface], capture_output=True)
    subprocess.run(["ip", "link", "add", iface, "type", "dummy"], check=True)
    try:
        subprocess.run(["ip", "link", "set", iface, "up"], check=True)
        fppd.start(extra_env={"NM_IFACE": iface})
        fppd.wait_for(lambda: "fpp-netmon Counts" in {c["name"] for c in fppd.get("/commands")},
                      timeout=15, interval=0.25, what="the plugin to load")
        end = time.time() + 8
        n = 0
        while time.time() < end:
            subprocess.run(["ip", "addr", "add", f"10.77.{n % 200}.1/24", "dev", iface], check=True)
            time.sleep(0.01)
            subprocess.run(["ip", "addr", "del", f"10.77.{n % 200}.1/24", "dev", iface], check=True)
            n += 1
        passes, calls = map(int, str(fppd.command("fpp-netmon Counts", timeout=10)).split())
        # The control: the plugin churned, and its callbacks ran for the changes.
        assert passes > 50 and calls > 20, (passes, calls, n)
        assert fppd.get("/fppd/status", timeout=5)["status_name"]
    finally:
        subprocess.run(["ip", "link", "del", iface], capture_output=True)
