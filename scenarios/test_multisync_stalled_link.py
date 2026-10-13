"""MultiSync over a link that has stopped transmitting.

FalconChristmas/fpp#3072: mid-show, a Pi 4's Wi-Fi stopped sending. The
multicast sync socket bound to wlan0 filled its send buffer, and the
channel output thread then slept in a blocking sendto() on it -- holding
m_socketLock, so the main loop's media sync send queued up behind it.
Pixel output froze on every controller, including the ones on a healthy
wired interface, until the box was power cycled.

Here a dummy interface sits behind a plug qdisc that never lets a packet
go. A held packet stays charged to the socket that sent it, so the sync
sockets' buffers fill exactly as they did behind the stuck Wi-Fi. (netem
would not do: it orphans the packets it delays, releasing that charge.)
Channel output goes to a DDP receiver on loopback, which is healthy, and
must keep flowing.

Regression: 94ce02765 (fix(multisync): never block on a multicast or
broadcast sync send). Before it, output stops as soon as the buffer fills.
"""

import contextlib
import re
import subprocess
import time

import pytest

from ddp import DdpReceiver
from fseq import unique_frames
from show import CHANNELS, install, status

STEP_MS = 10
IFACE = "fpptest0"


def ip(*args):
    return subprocess.run(["ip", *args], capture_output=True, text=True)


@contextlib.contextmanager
def stalled_interface(address):
    """A dummy interface with an address fppd will sync on, whose qdisc
    never lets a packet go. Needs NET_ADMIN and sch_plug."""
    r = ip("link", "add", IFACE, "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        ip("addr", "add", address + "/24", "dev", IFACE)
        ip("link", "set", IFACE, "up")
        ip("route", "add", "224.0.0.0/4", "dev", IFACE)
        r = subprocess.run(["tc", "qdisc", "add", "dev", IFACE, "root", "plug",
                            "limit", "100000000"], capture_output=True, text=True)
        if r.returncode:
            pytest.skip(f"cannot add a plug qdisc: {r.stderr.strip()}")
        subprocess.run(["tc", "qdisc", "change", "dev", IFACE, "root", "plug", "block"], check=True)
        yield
    finally:
        ip("link", "del", IFACE)


def held_packets():
    """How many packets the stalled interface is holding."""
    out = subprocess.run(["tc", "-s", "qdisc", "show", "dev", IFACE],
                         capture_output=True, text=True).stdout
    m = re.search(r"backlog \S+ (\d+)p", out)
    return int(m.group(1)) if m else 0


def test_stalled_sync_link_does_not_stop_output(fppd):
    """Multicast and broadcast sync over a link that never transmits: once
    the sync sockets' buffers are full, the sends are dropped, and channel
    output to a healthy controller carries on at full rate."""
    frames = unique_frames(6000, CHANNELS)  # 60 s at 10 ms
    with contextlib.ExitStack() as stack:
        stack.enter_context(stalled_interface("10.77.0.1"))
        rx = stack.enter_context(DdpReceiver(CHANNELS))
        install(fppd, frames, step_ms=STEP_MS)
        fppd.settings(MultiSyncEnabled="1", MultiSyncMulticast="1", MultiSyncBroadcast="1")
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        assert rx.wait_frames(50, timeout=10), "no output once the show started"

        # Run until the held packets plateau: the sockets are full and every
        # later send is being refused (or, before the fix, blocked on).
        began = time.monotonic()
        last, steady_since = -1, time.monotonic()
        while time.monotonic() - began < 45:
            time.sleep(1)
            held = held_packets()
            if held != last:
                last, steady_since = held, time.monotonic()
            elif held > 0 and time.monotonic() - steady_since >= 5:
                break
        assert last > 0, "the stalled interface never held a sync packet"

        since = time.monotonic()
        time.sleep(2)
        n = rx.count(since=since)
        assert n >= 100, \
            f"{n} frames in 2 s at {1000 // STEP_MS} fps once {last} sync packets were stuck"
        assert status(fppd).get("status_name") == "playing", status(fppd)
        fppd.command("Stop Now")
