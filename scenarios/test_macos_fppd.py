"""fppd's macOS-only code, on a Mac (macfppd.py): shutting down (also with the
WLED API responder on), the socket framebuffer FPPMon draws from, and the
CoreAudio output-device lookup.

The test fppd runs with a scratch media directory, MultiSync off, no
channel outputs, and netguard_mac.dylib refusing anything past loopback, so
it reaches nothing beyond this Mac. Each scenario also checks that it ended
with no connection off the loopback. Skipped anywhere but macOS, and where
another fppd already answers on 127.0.0.1:32322.
"""

import array
import os
import socket
import struct
import threading
import time

from macfppd import dylib, macfppd  # noqa: F401 -- the fixture

FATAL = ("terminate called", "mutex lock failed", "libc++abi", "Segmentation fault")


def test_fppd_stops_cleanly(macfppd):
    """fppd started and stopped (SIGTERM) three times over exits 0 each
    time, with nothing on its way out about a terminate or a failed mutex
    lock.

    Regression: 44e55bd17. On macOS the static destructors ran after main()
    had already torn every subsystem down, and one of them locked a mutex
    of a singleton destroyed before it: libc++ threw "mutex lock failed:
    Invalid argument" out of a noexcept destructor and fppd died in
    std::terminate on every shutdown."""
    for i in range(3):
        macfppd.start()
        assert not macfppd.off_box(), macfppd.off_box()
        rc = macfppd.stop()
        out = macfppd.output()
        assert rc == 0, f"stop {i + 1}: fppd exited {rc}\n{out}"
        assert not [w for w in FATAL if w in out], f"stop {i + 1}:\n{out}"


def test_fppd_stops_with_the_wled_api_responder_on(macfppd):
    """With the WLED API responder on, as it is by default, fppd stops
    (SIGTERM) within 15 s and exits 0, also with a client connected to the
    responder that has sent nothing.

    Regression: 657efd007. The responder's Cleanup() woke its accept thread
    with shutdown() on the listening socket. On Linux that makes accept() return;
    on macOS it doesn't, so the join on the accept thread never ended and
    fppd hung on every stop."""
    macfppd.settings(WLEDAPIResponder="1")
    macfppd.start()
    idle = socket.create_connection(("127.0.0.1", 32327), timeout=5)
    try:
        # the idle connection has its own thread by now, blocked in recv()
        time.sleep(0.5)
        start = time.monotonic()
        rc = macfppd.stop(timeout=15)
        took = time.monotonic() - start
    finally:
        idle.close()
    out = macfppd.output()
    assert rc != "hung", f"fppd was still running 15 s after SIGTERM:\n{out}"
    assert rc == 0, f"fppd exited {rc} after {took:.1f} s\n{out}"


class FakeMon:
    """FPPMon's end of the socket framebuffer: a unix datagram socket at
    `path` that records each message's command (1: the framebuffer config,
    which carries the shared-memory fd; 2: show a page)."""

    def __init__(self, path):
        self.path = path
        self.got = []
        self.lock = threading.Lock()
        self.sock = None
        self.bind()

    def bind(self):
        if os.path.exists(self.path):
            os.unlink(self.path)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.sock.bind(self.path)
        self.sock.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._run, args=(self.sock,), daemon=True)
        self.thread.start()

    def _run(self, sock):
        while self.running:
            try:
                data, anc, _, _ = sock.recvmsg(64, socket.CMSG_SPACE(4 * 4))
            except socket.timeout:
                continue
            except OSError:
                return
            for level, kind, payload in anc:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    fds = array.array("i")
                    fds.frombytes(payload[:len(payload) - len(payload) % fds.itemsize])
                    for fd in fds:
                        os.close(fd)
            if len(data) >= 2:
                with self.lock:
                    self.got.append(struct.unpack("<H", data[:2])[0])

    def restart(self):
        """As FPPMon starting again: the old socket gone, a new one bound
        over the same path (a new inode)."""
        self.running = False
        self.thread.join()
        self.sock.close()
        with self.lock:
            self.got = []
        self.bind()

    def commands(self):
        with self.lock:
            return list(self.got)

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()


def test_a_restarted_fppmon_gets_the_framebuffer_config_again(macfppd):
    """An FB model drawing into the socket framebuffer, with FPPMon's
    socket up when fppd starts: the config (1) comes, then page syncs (2)
    as the model is drawn. FPPMon restarts -- unlink and bind of the same
    path -- and the new socket gets the config again before more pages.

    Regression: caa0c8831. fppd only checked that the socket path existed,
    which it did throughout, so a restarted FPPMon got page syncs for a
    buffer it was never given and showed nothing."""
    sockdir = os.path.join(macfppd.dir, "fb")
    os.makedirs(sockdir)
    mon = FakeMon(os.path.join(sockdir, "fb1"))
    try:
        macfppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
            {"Name": "Mon", "Type": "FB", "Width": 8, "Height": 4, "Device": "fb1"}]})
        macfppd.settings(framebufferControlSocketPath=sockdir)
        macfppd.start()

        def draw_until(pred, what, timeout=10):
            deadline = time.monotonic() + timeout
            v = 0
            while not pred():
                assert time.monotonic() < deadline, f"{what}: got {mon.commands()}\n{macfppd.output()}"
                v = (v + 37) % 256
                macfppd.request("PUT", "/overlays/model/Mon/data?autoEnable=true&stopEffect=false",
                                bytes([v]) * (8 * 4 * 3))
                time.sleep(0.1)

        draw_until(lambda: 1 in mon.commands() and 2 in mon.commands(), "the config, then pages")
        mon.restart()
        draw_until(lambda: mon.commands().count(2) >= 5, "pages to the restarted socket")
        got = mon.commands()
        assert 1 in got and got.index(1) < got.index(2), f"the restarted FPPMon got {got}"
        assert not macfppd.off_box(), macfppd.off_box()
    finally:
        mon.close()


def test_a_device_whose_driver_overstates_its_buffers_is_survived(macfppd):
    """AudioOutput names an output device ("FakeOut") whose stream
    configuration says it has 0x40000000 buffers in a reply with room for
    one (coreaudio_fake_mac.c): fppd finds the device, sets its volume at
    startup, and keeps running; the volume goes to FakeOut, not the
    default device.

    Regression: d31a5b59d. The lookup walked as many buffers as
    mNumberBuffers said, far past the bytes CoreAudio returned, and fppd
    died reading them. (The other halves -- results of failed calls, the
    unterminated name, the unlocked cache -- are not reached here.)"""
    log = os.path.join(macfppd.dir, "coreaudio.log")
    macfppd.settings(AudioOutput="FakeOut", volume="70")
    macfppd.start(preload=[dylib("coreaudio_fake_mac.c", "-framework", "CoreAudio")],
                  extra_env={"COREAUDIO_FAKE_LOG": log})
    macfppd.request("POST", "/fppd/volume/40")
    deadline = time.monotonic() + 10
    sets = []
    while time.monotonic() < deadline:
        sets = open(log).read().split("\n") if os.path.exists(log) else []
        if any(l.startswith("set-volume 1002") for l in sets):
            break
        time.sleep(0.25)
    assert macfppd.proc.poll() is None, f"fppd exited {macfppd.proc.returncode}\n{macfppd.output()}"
    assert any(l.startswith("set-volume 1002") for l in sets), f"volume calls: {sets}\n{macfppd.output()}"
    assert not any(l.startswith("set-volume 1001") for l in sets), sets
    assert not macfppd.off_box(), macfppd.off_box()


def test_fppmon_started_after_fppd_gets_the_framebuffer(macfppd):
    """An FB model on the socket framebuffer, fppd started before FPPMon has
    set framebufferControlSocketPath: once FPPMon writes the setting and
    binds its socket there, it gets the config (1) and then page syncs (2)
    as the model is drawn, with no restart of fppd.

    Regression: 600533699. SocketFrameBuffer kept the socket path it built
    at init from the default "/dev", so an FPPMon started after fppd was
    never found: the model drew into a buffer nothing showed until fppd was
    restarted."""
    sockdir = os.path.join(macfppd.dir, "fb")
    os.makedirs(sockdir)
    macfppd.write("config/model-overlays.json", {"autoCreate": False, "models": [
        {"Name": "Mon", "Type": "FB", "Width": 8, "Height": 4, "Device": "fb1"}]})
    macfppd.start()
    mon = None
    try:
        # FPPMon starting: the setting, as it saves it, then its socket.
        macfppd.settings(framebufferControlSocketPath=sockdir)
        time.sleep(2)  # the settings file monitor's reload
        mon = FakeMon(os.path.join(sockdir, "fb1"))
        deadline = time.monotonic() + 15
        v = 0
        while not (1 in mon.commands() and mon.commands().count(2) >= 3):
            assert time.monotonic() < deadline, \
                f"FPPMon got {mon.commands()} from fppd started before it\n{macfppd.output()}"
            v = (v + 37) % 256
            macfppd.request("PUT", "/overlays/model/Mon/data?autoEnable=true&stopEffect=false",
                            bytes([v]) * (8 * 4 * 3))
            time.sleep(0.1)
        got = mon.commands()
        assert got.index(1) < got.index(2), f"FPPMon got {got}"
        assert not macfppd.off_box(), macfppd.off_box()
    finally:
        if mon:
            mon.close()
