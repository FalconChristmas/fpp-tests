"""fppd's mDNS (MDNSBackendAvahi.cpp) against a real avahi-daemon, seen from
another box on the network: what it hears fppd's daemon say on the wire, and
what fppd makes of the services that box announces.

The `avahi` fixture (test_mdns.py) gives the run an avahi-daemon of its own.
The `mdns_box` fixture is the other box: a network namespace holding
10.88.0.2, joined to this one by a veth (fake_devices.device_network), where
mdns_box.py prints every mDNS service pointer it hears ("ptr <service>
<instance> <ttl>") and, when asked, announces a service of its own -- a WLED
here, which a fake_device_server.py beside it serves the web pages of.
"""

import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

import pytest

from fake_devices import DEV_IF, HOST_IF, NETNS, SERVER, _ip, device_network, page, wait_ready
from test_mdns import HOST, avahi, fppd_names  # noqa: F401 -- fixture

HERE = os.path.dirname(os.path.abspath(__file__))
BOX = "10.88.0.2"
BOX_SCRIPT = os.path.join(HERE, "mdns_box.py")

WLED_PAGES = {
    "/": page("<html><head><title>WLED UI</title></head><body></body></html>"),
    "/json/info": page({"ver": "0.14.4", "name": "wled-porch", "arch": "esp32",
                        "mac": "a0b1c2d3e4f5"}),
}


class MdnsBox:
    def __init__(self, proc):
        self.proc = proc
        self.lines = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            with self.lock:
                self.lines.append((time.monotonic(), line.split()))

    def pointers(self, service, since=0):
        """(time, instance, ttl) for each pointer to an instance of
        `service` ("_fppd._udp.local") heard since `since`."""
        with self.lock:
            return [(t, f[2], int(f[3])) for t, f in self.lines
                    if t >= since and len(f) == 4 and f[0] == "ptr" and f[1] == service]


def start_box(run, announce=None):
    _ip("route", "add", "224.0.0.0/4", "dev", DEV_IF, ns=NETNS)
    _ip("link", "set", HOST_IF, "multicast", "on")
    args = [sys.executable, "-I", BOX_SCRIPT, HERE, BOX]
    if announce:
        args += announce
    p = run(*args)
    assert p.stdout.readline().strip() == "ready", "the mDNS box never came up"
    return MdnsBox(p)


@pytest.fixture
def mdns_box():
    """The other box, listening only."""
    with device_network([BOX]) as run:
        yield start_box(run)


@pytest.fixture
def wled_box():
    """The other box as a WLED: it announces wled-porch._wled._tcp on port
    80 and serves a WLED's front page and /json/info there."""
    with device_network([BOX]) as run, tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump({BOX: WLED_PAGES}, f)
        f.flush()
        wait_ready(run(sys.executable, "-I", SERVER, f.name), BOX)
        yield start_box(run, ["wled-porch", "_wled._tcp", "80", "mac=a0b1c2d3e4f5"])


def advertised(timeout):
    deadline = time.monotonic() + timeout
    while True:
        names = fppd_names()
        if HOST in names or time.monotonic() >= deadline:
            return HOST in names, names
        time.sleep(0.5)


def test_the_service_is_withdrawn_before_a_slow_shutdown(mdns_box, avahi, fppd):
    """On SIGTERM fppd withdraws its mDNS services first: while its shutdown
    is still held in a channel output's Close() (4 s, slowcloseoutputplugin),
    the other box has already heard the goodbye for "<host>._fppd._udp"
    (a pointer with TTL 0) and the local daemon no longer lists it. Then
    fppd finishes and exits 0.

    Regression: 4c252a792. mDNS was torn down after the media, effects and
    channel outputs were closed, so a shutdown held up in any of them --
    or killed there, as fppd_stop does after its timeout -- left the
    service advertised, and peers kept it in their caches.
    """
    from native_plugin import install as install_plugin
    marker = os.path.join(fppd.media, "tmp-closing")
    install_plugin(fppd, name="fpp-slowclose", source="slowcloseoutputplugin.cpp")
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "fpp-slowclose", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "closeMs": 4000, "markerFile": marker}]})
    fppd.settings(LogLevel_Sync="info")
    fppd.start()
    fppd.wait_for(lambda: "Calling Init() on fpp-slowclose output" in fppd.log(),
                  timeout=10, what="the plugin's output to load")
    ok, names = advertised(30)
    assert ok, f"precondition: fppd advertises its service: {names}\n{fppd.tail()}"
    fppd.wait_for(lambda: [p for p in mdns_box.pointers("_fppd._udp.local") if p[2] > 0],
                  timeout=20, interval=0.25, what="the other box to hear fppd's service")

    fppd.exit_expected = True
    fppd.proc.send_signal(signal.SIGTERM)
    fppd.wait_for(lambda: os.path.exists(marker) or fppd.proc.poll() is not None, timeout=20,
                  interval=0.05, what="fppd's shutdown to reach the channel outputs")
    assert fppd.proc.poll() is None, "precondition: fppd is held in its outputs' Close()"
    closing = time.monotonic()

    def withdrawn():
        bye = [p for p in mdns_box.pointers("_fppd._udp.local", since=closing - 1)
               if p[1].startswith(HOST + ".") and p[2] == 0]
        return bye and HOST not in fppd_names()
    while not withdrawn() and fppd.proc.poll() is None and time.monotonic() - closing < 3:
        time.sleep(0.2)
    held = fppd.proc.poll() is None and time.monotonic() - closing < 3.5
    heard = mdns_box.pointers("_fppd._udp.local", since=closing - 1)
    names = fppd_names()
    assert held, "precondition: checked while fppd was still in the slow Close()"
    assert [p for p in heard if p[1].startswith(HOST + ".") and p[2] == 0], \
        f"the other box heard no goodbye for fppd's service while it shut down: {heard}"
    assert HOST not in names, f"fppd's service is still published while it shuts down: {names}"
    assert fppd.stop() == 0


def systems(fppd):
    return {s["address"]: s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if not s.get("local")}


def test_a_wled_announced_over_mdns_is_listed(wled_box, avahi, fppd):
    """A WLED that announces _wled._tcp, and answers neither pings nor
    anything else fppd sends, is found through that announcement: fppd
    probes it over HTTP and lists it as a WLED, under the name its
    /json/info gives.

    Regression: a800d95ba. fppd browsed for _fppd._udp only; a WLED was
    found only by HTTP discovery of configured outputs or subnets, so this
    one was never listed.
    """
    fppd.settings(LogLevel_Sync="debug")
    fppd.start()
    fppd.wait_for(lambda: BOX in systems(fppd), timeout=30, interval=0.5,
                  what=f"the WLED at {BOX} to be listed in multiSyncSystems")
    s = fppd.wait_for(lambda: systems(fppd)[BOX] if systems(fppd)[BOX].get("hostname") == "wled-porch"
                      else None, timeout=10, interval=0.5, what="the WLED's name from /json/info")
    assert s["typeId"] == 0xFB and s["type"] == "WLED", s
    assert f"MDNS discovered new host {BOX} (wled)" in fppd.log(), fppd.tail()


def _epoll_fds(pid):
    """{epoll fd: set of the fds registered in it} for process `pid`."""
    out = {}
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            if os.readlink(f"/proc/{pid}/fd/{fd}") != "anon_inode:[eventpoll]":
                continue
            with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                out[int(fd)] = {int(m) for m in re.findall(r"^tfd:\s+(\d+)", f.read(), re.M)}
        except OSError:
            continue
    return out


def _socket_fds(pid):
    """{socket inode: fd} for process `pid`."""
    out = {}
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            m = re.match(r"socket:\[(\d+)\]", os.readlink(f"/proc/{pid}/fd/{fd}"))
        except OSError:
            continue
        if m:
            out[int(m.group(1))] = int(fd)
    return out


def _multisync_inodes():
    """Inodes of the UDP sockets bound to MultiSync's port, 32320."""
    found = set()
    with open("/proc/net/udp") as f:
        for line in f.readlines()[1:]:
            parts = line.split()
            if parts[1].endswith(":7E40"):
                found.add(int(parts[9]))
    return found


def _system_bus_peers():
    """Inodes of the client ends of connections to the system bus."""
    out = subprocess.run(["ss", "-x", "-n"], capture_output=True, text=True).stdout
    return {int(m.group(1)) for m in re.finditer(r"/run/dbus/system_bus_socket \d+\s+\* (\d+)", out)}


def test_avahi_is_driven_from_the_main_loop(mdns_box, avahi, fppd):
    """fppd's connection to avahi-daemon (its D-Bus socket) is one of the
    descriptors of the main loop's epoll set -- the set that holds the
    MultiSync socket -- and the service is advertised and heard on the wire
    through it: Avahi runs on fppd's event loop, not on a thread of its own.

    Regression: 38da41a5a. Avahi ran avahi_simple_poll_loop() on a thread of
    its own, which polled that socket itself (it was in no epoll set), and
    called back into MDNSManager and MultiSync from there.
    """
    import shutil
    if not shutil.which("ss"):
        pytest.skip("no ss (iproute2) to pair fppd's socket with the bus")
    fppd.start()
    ok, names = advertised(30)
    assert ok, f"precondition: fppd advertises its service: {names}\n{fppd.tail()}"
    fppd.wait_for(lambda: [p for p in mdns_box.pointers("_fppd._udp.local") if p[1].startswith(HOST)],
                  timeout=20, interval=0.25, what="the other box to hear fppd's service")
    pid = fppd.proc.pid
    sockets = _socket_fds(pid)
    bus = {sockets[i] for i in _system_bus_peers() if i in sockets}
    assert bus, f"precondition: fppd has a connection to the system bus: {sockets}"
    multisync = {sockets[i] for i in _multisync_inodes() if i in sockets}
    assert multisync, "precondition: fppd holds MultiSync's port"
    main = [fds for fds in _epoll_fds(pid).values() if fds & multisync]
    assert main, f"precondition: an epoll set holds MultiSync's socket: {_epoll_fds(pid)}"
    assert bus & main[0], (f"fppd's system bus connection (fd {sorted(bus)}) is not in the main "
                           f"loop's epoll set {sorted(main[0])}")


def test_a_wled_is_probed_while_pings_arrive(wled_box, avahi, fppd):
    """The WLED found over mDNS is probed and listed while another system's
    pings arrive on the main loop, 20 a second: the probe thread and the
    main loop each look up an address at the same moment, with no report
    from the sanitizer. heldhostent.so holds gethostbyname()'s answer for the
    WLED's address 500 ms before handing it back, as a preempted caller
    would, so the two lookups overlap every time.

    Regression: 963c07cb6 (run with --flavor tsan). MultiSync resolved with
    gethostbyname(), which answers in one static hostent for the whole
    process: the main loop's lookup for each ping rewrote it under the
    thread probing the WLED, a data race TSan reports on that hostent.
    """
    import shims
    from multisync import ping_packet
    from test_multisync_systems import send
    fppd.settings(LogLevel_Sync="debug")
    fppd.start(preload=[shims.build("heldhostent.c")],
               extra_env={"HELDHOSTENT_NAME": BOX, "HELDHOSTENT_ADDR": BOX, "HELDHOSTENT_MS": "500"})
    done = threading.Event()

    def pinger():
        while not done.is_set():
            send(ping_packet("10.20.31.47", "pinging-peer"))
            done.wait(0.05)
    t = threading.Thread(target=pinger, daemon=True)
    t.start()
    try:
        fppd.wait_for(lambda: BOX in systems(fppd) and systems(fppd)[BOX].get("type") == "WLED",
                      timeout=30, interval=0.5, what=f"the WLED at {BOX} to be listed as one")
        time.sleep(1)
    finally:
        done.set()
        t.join()
    assert "10.20.31.47" in systems(fppd)
