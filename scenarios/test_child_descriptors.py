"""What fppd's children inherit from it: the shells and tools it runs
(system(), popen()) get its standard descriptors and every descriptor that is
not close-on-exec, and keep them as long as they run, past fppd's own exit."""

import os
import socket
import threading
import time
import urllib.error

from packets import DDP_PORT, Sender, ddp
from test_bridge_inputs import OUT_PORT, region, setup, wait_output
from test_media import Daemonized, wait_daemon
from test_mqtt_control import PORT as MQTT_PORT, broker
from test_status_websocket import snapshot
from udp import Listener
from wsclient import WebSocket

CLOEXEC = 0o2000000


def network_sockets():
    """Every TCP/UDP/raw socket in this network namespace: inode -> (table,
    local address, remote address), as /proc/net prints them."""
    found = {}
    for table in ("tcp", "tcp6", "udp", "udp6", "raw", "raw6"):
        try:
            with open(f"/proc/net/{table}") as f:
                rows = f.read().splitlines()[1:]
        except FileNotFoundError:
            continue
        for row in rows:
            col = row.split()
            found[col[9]] = (table, col[1], col[2])
    return found


def inheritable_network_sockets(pid):
    """The network sockets process `pid` holds without close-on-exec, which
    every child it runs would inherit: (fd, table, local, remote)."""
    net = network_sockets()
    held = []
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            target = os.readlink(f"/proc/{pid}/fd/{fd}")
            with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                flags = int(next(l for l in f if l.startswith("flags:")).split()[1], 8)
        except (FileNotFoundError, StopIteration):
            continue
        inode = target[len("socket:["):-1] if target.startswith("socket:[") else None
        if inode in net and not flags & CLOEXEC:
            held.append((int(fd),) + net[inode])
    return sorted(held)


def connections_to(pid, port):
    """The TCP connections process `pid` holds to `port` on this host."""
    net = network_sockets()
    remote = f":{port:04X}"
    ours = []
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            target = os.readlink(f"/proc/{pid}/fd/{fd}")
        except FileNotFoundError:
            continue
        info = net.get(target[len("socket:["):-1]) if target.startswith("socket:[") else None
        if info and info[0].startswith("tcp") and info[2].endswith(remote):
            ours.append(int(fd))
    return ours


def standard_descriptors(pid):
    """What process `pid` has on fds 0-2 (None for a closed one)."""
    seen = []
    for fd in (0, 1, 2):
        try:
            seen.append(os.readlink(f"/proc/{pid}/fd/{fd}"))
        except FileNotFoundError:
            seen.append(None)
    return seen


def bridged(fppd, out, value):
    """Stream DDP to fppd until `value` comes back out on the raw output:
    the bridge's sockets are read by fppd's main loop."""
    with Sender(lambda n: [(ddp(0, bytes([value]) * 30, seq=n % 15 + 1), DDP_PORT)]):
        wait_output(fppd, out, lambda f: region(f, 1, 30) == bytes([value]) * 30,
                    f"the bridged {value:#x} on the output")


def ticking(fppd):
    """The status websocket pushes a new snapshot as the clock ticks: drogon's
    main loop runs that broadcast on a timer."""
    ws = WebSocket("/fppdws")
    try:
        uptimes = set()
        deadline = time.monotonic() + 10
        while len(uptimes) < 3 and time.monotonic() < deadline:
            try:
                uptimes.add(snapshot(ws, timeout=max(deadline - time.monotonic(), 0.01))["uptime"])
            except socket.timeout:
                break
        assert len(uptimes) >= 3, f"the status websocket pushed uptimes {sorted(uptimes)} in 10 s"
    finally:
        ws.close()


def test_a_daemonized_fppd_keeps_its_standard_descriptors_on_dev_null(fppd):
    """fppd started with "-d" has /dev/null on fds 0-2, and so does the
    daemon a "Restart FPPD" leaves behind, whose main loop still hears its
    bridge's input.

    Regression: 434337bbf. CreateDaemon() closed fds 0-2 without reopening
    them, so the next files and sockets fppd opened took those numbers, and
    every child fppd ran got them as its stdin, stdout and stderr. A "-d"
    restart closed 0-2 before its exec, so the restarted fppd's static
    initializers opened drogon's main loop (its epoll, timerfd and eventfd)
    on them, and CreateDaemon() then closed those: the restarted daemon still
    answered its API, but the status websocket, broadcast from a timer on
    that loop, stopped pushing. The bridged DDP checks that EPollManager's
    loop, which no longer keeps its epoll off fds 0-2 by hand, still runs."""
    setup(fppd)
    with Listener(OUT_PORT) as out:
        d = Daemonized(fppd)
        try:
            assert standard_descriptors(d.pid) == ["/dev/null"] * 3, \
                f"the daemon's fds 0-2: {standard_descriptors(d.pid)}"
            bridged(fppd, out, 0x21)
            ticking(fppd)

            first = d.pid
            try:
                fppd.command("Restart FPPD", timeout=5)
            except (urllib.error.URLError, ConnectionError, TimeoutError):
                pass
            # The restart execs in place and daemonizes again, so the daemon
            # it leaves is a new process and this one exits.
            assert wait_daemon(first, 60) is not False, "the daemon did not restart"
            fppd.wait_for(lambda: _answers(fppd) and len(d.daemons()) == 1, timeout=60, interval=0.5,
                          what="the restarted daemon to answer")
            d.pid = d.daemons()[0]

            assert standard_descriptors(d.pid) == ["/dev/null"] * 3, \
                f"the restarted daemon's fds 0-2: {standard_descriptors(d.pid)}"
            bridged(fppd, out, 0x42)
            ticking(fppd)
        finally:
            d.stop()


def _answers(fppd):
    try:
        fppd.get("/fppd/status", timeout=2)
        return True
    except (urllib.error.URLError, ConnectionError, TimeoutError, ValueError):
        return False


def test_a_url_commands_connection_is_not_inherited(fppd):
    """While a URL command waits on its server, fppd holds that connection
    close-on-exec, as it does every other network socket.

    Regression: 7a9e8e33d. libcurl opens its connections without
    close-on-exec, so every shell and tool fppd ran while one was open
    inherited it, and kept it as long as it ran."""
    sink = socket.socket()
    sink.bind(("127.0.0.1", 0))
    sink.listen(16)  # accepts the connection, never answers
    port = sink.getsockname()[1]
    try:
        fppd.start()

        def run():
            try:
                fppd.command("URL", f"http://127.0.0.1:{port}/hook", "GET", "", timeout=20)
            except Exception:
                pass

        threading.Thread(target=run, daemon=True).start()
        fppd.wait_for(lambda: connections_to(fppd.proc.pid, port), timeout=10,
                      what="fppd to connect to the URL's server")
        held = inheritable_network_sockets(fppd.proc.pid)
        assert not held, f"fppd's children would inherit these (fd, table, local, remote): {held}"
    finally:
        sink.close()


def test_the_mqtt_brokers_connection_is_not_inherited(fppd):
    """fppd holds its connection to the MQTT broker close-on-exec, as it
    does every other network socket.

    Regression: 7a9e8e33d. libmosquitto opens its connection without
    close-on-exec, so every shell and tool fppd ran inherited it, and kept
    it as long as it ran."""
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=MQTT_PORT, HostName="mqtttest")
    with broker():
        fppd.start()
        fppd.wait_for(lambda: connections_to(fppd.proc.pid, int(MQTT_PORT)), timeout=10,
                      what="fppd to connect to the broker")
        time.sleep(1)  # past the CONNACK, which a reconnect also goes through
        held = inheritable_network_sockets(fppd.proc.pid)
        assert not held, f"fppd's children would inherit these (fd, table, local, remote): {held}"
