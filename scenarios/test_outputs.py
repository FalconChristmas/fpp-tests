"""Channel outputs: what reaches the network, and what config reloads do to it.

Outputs point at 127.0.0.1 and a udp.Listener counts what arrives. Test mode
keeps channel data flowing at a steady rate while a scenario saves configs.
"""

import os
import time

import pytest

import shims
from fppd import sanitizer
from udp import Listener

GENERIC_PORT = 5000
# Somewhere E1.31 goes nowhere: at 127.0.0.1 it would reach fppd's own E1.31
# input bridge and feed back into the output thread. "monitor": 0, or fppd pings
# it, gets no answer, and reconfigures the output to drop it.
E131_ADDRESS = "192.0.2.1"


def universes(description):
    """co-universes.json: one unicast E1.31 universe to localhost."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 512,
        "universes": [{"active": 1, "description": description, "id": 1,
                       "startChannel": 1, "channelCount": 512, "type": 1,
                       "address": E131_ADDRESS, "priority": 0, "monitor": 0,
                       "deDuplicate": 0}],
    }]}


def generic_udp(description, enabled=1):
    """co-other.json: one GenericUDP output to localhost."""
    return {"channelOutputs": [{
        "type": "GenericUDP", "enabled": enabled, "startChannel": 1, "channelCount": 3,
        "description": description, "address": "127.0.0.1", "port": GENERIC_PORT,
        "tokens": "",
    }]}


def start_test_mode(fppd):
    fppd.command("Test Start", "100", "RGB Cycle", "1-512", "R-G-B")


def steady_rate(listener, settle=1.5, window=2.0):
    """Packets per second once a reload has had time to land."""
    time.sleep(settle)
    return listener.rate(window)


def test_generic_udp_survives_config_saves(fppd):
    """Saving either output config leaves a GenericUDP output sending once
    per frame -- not silenced, not doubled -- and disabling it stops it.

    Regression: e2422ff8e. GenericUDP handed its data object to the shared
    UDP output and never took it back: saving the E1.31 config replaced the
    UDP output and silenced GenericUDP, each save of the Other outputs added
    another copy (15 -> 38 -> 76 packets/s), and disabling it stopped none.
    """
    with Listener(GENERIC_PORT) as listener:
        fppd.write("config/co-universes.json", universes("a"))
        fppd.write("config/co-other.json", generic_udp("a"))
        fppd.start()
        start_test_mode(fppd)

        # Test mode takes a couple of seconds to reach its steady frame rate.
        base = steady_rate(listener, settle=3)
        assert base > 3, f"GenericUDP is not sending under test mode ({base}/s)"

        def assert_like_base(after):
            rate = steady_rate(listener)
            assert 0.5 * base <= rate <= 1.6 * base, \
                f"after {after}: {rate:.1f} packets/s, was {base:.1f}"

        fppd.write("config/co-universes.json", universes("b"))
        assert_like_base("saving the E1.31 config")
        fppd.write("config/co-other.json", generic_udp("b"))
        assert_like_base("saving the Other outputs")
        fppd.write("config/co-other.json", generic_udp("c"))
        assert_like_base("saving the Other outputs again")

        fppd.write("config/co-other.json", generic_udp("c", enabled=0))
        rate = steady_rate(listener)
        assert rate == 0, f"a disabled GenericUDP output still sends {rate:.1f} packets/s"


@pytest.mark.skipif(sanitizer() is not None,
                    reason="needs a build without a sanitizer: ASan and TSan intercept "
                           "dlopen(), so fppd finds its plugins only through "
                           "LD_LIBRARY_PATH, which then finds their dependencies too")
def test_generic_udp_loads_without_the_universes_output_loaded_first(fppd):
    """A GenericUDP output that is the only output when fppd starts, with no
    LD_LIBRARY_PATH (as systemd starts fppd on a player), still loads, and
    once an E1.31 config is saved it sends.

    Regression: 9d5a7708e. libfpp-co-GenericUDP.so links
    libfpp-co-UDPOutput.so but had no RUNPATH of its own, and a dlopen()ed
    library finds its dependencies only through its own RUNPATH, never
    fppd's. It loaded only when the E1.31/DDP config had already pulled
    UDPOutput into the process; on its own, dlopen failed ("Could not create
    output type GenericUDP"), and saving an E1.31 config later did not bring
    it back, since co-other.json is not reloaded. GenericUDP's packets go out
    through the UDP output, so it only sends once there is one.

    The harness puts the build directory on LD_LIBRARY_PATH, which hides
    this, so the scenario clears it. That only works without a sanitizer:
    an ASan or TSan fppd won't start without its directory there, since
    their dlopen() interceptor stops fppd's own RUNPATH from finding even
    libfpp-co-GenericUDP.so (test_startup.py checks that refusal). So it
    runs in the debug, optimized and coverage builds and skips in the ASan
    and TSan ones. Proved by reverting the fix on master: the parent also
    fails the load check, but its GenericUDP could not join a UDP output that
    came later (that is e2422ff8e).
    """
    with Listener(GENERIC_PORT) as listener:
        fppd.write("config/co-other.json", generic_udp("alone"))
        fppd.start(extra_env={"LD_LIBRARY_PATH": ""})
        # fppd loads its outputs before its API answers, so any load
        # failure is already a warning by now.
        warnings = fppd.get("/fppd/status").get("warnings", [])
        failed = [line for line in fppd.log().splitlines() if "Failed to load shlib" in line]
        assert not any("Could not create output type GenericUDP" in w for w in warnings), \
            f"GenericUDP did not load on its own: {warnings} {failed}"

        start_test_mode(fppd)
        fppd.write("config/co-universes.json", universes("added later"))
        fppd.wait_for(lambda: listener.count_since(0) > 0, timeout=15,
                      what="GenericUDP's first packet after the E1.31 config was saved")


def test_controller_that_comes_up_late_gets_the_show(fppd):
    """A controller that is off when the show starts is dropped from the
    output with a warning once its pings fail, and picked back up -- data
    flowing, warning gone -- once it answers again, without any reload.
    (fppd pings every 15 s and drops a host after two failed pings and a
    failed HTTP probe, so this takes a minute or so.)

    Regression: bc0747e90 (verify with --flavor tsan). The ping thread
    flipped each output's plain bool `valid` in SetHostValid() while the
    output thread read it in PrepData(): a data race TSan reports when the
    controller comes back."""
    import subprocess

    from ddp import DdpReceiver
    from fseq import unique_frames
    from show import CHANNELS, ddp_output, install

    address = "10.77.0.2"   # nothing answers here until the test adds it

    def host_warnings():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                if w.get("id") == 27]

    frames = unique_frames(4000, CHANNELS)  # 200 s, longer than the test
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        config = ddp_output(CHANNELS, address=address)
        config["channelOutputs"][0]["universes"][0]["monitor"] = 1
        fppd.write("config/co-universes.json", config)
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(host_warnings, timeout=120, interval=1,
                      what="fppd to give up on the unreachable controller")
        try:
            subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], check=True)
            up = time.monotonic()
            assert rx.wait_frames(20, timeout=40, since=up), \
                "the controller came up but fppd never sent it anything"
            fppd.wait_for(lambda: not host_warnings(), timeout=40, interval=1,
                          what="the unreachable-controller warning to clear")
            latest = rx.last()[:CHANNELS]
            assert latest in frames, "the late controller got data that is not the show"
        finally:
            subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"])


def test_controllers_that_answer_stay_up_when_the_ping_thread_is_late(fppd):
    """Controllers that answer their pings stay in the output and raise no
    unreachable-controller warning, even when fppd's ping thread only gets
    to their replies after their timeout. slowping.so holds the thread up
    400 ms after each wake-up, as a name lookup with no reachable DNS
    (1705b8e89 moved those onto it) or a busy single-core board does, so a
    burst of replies is always waiting by the time it reads. Four
    controllers on loopback answer every ping, over the three pings at
    startup and the first periodic one 15 s later.

    Regression: 32f043984. Each pass of the ping thread read one reply and
    then timed out every other pending ping (5c1ef6c76): the first host was
    credited, the rest counted a lost ping, and three in a row took a
    controller that was up out of the output with warning 27.
    """
    addresses = [f"127.0.0.{n}" for n in range(2, 6)]
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1,
        "channelCount": 3 * len(addresses),
        "universes": [{"active": 1, "description": f"controller {a}", "id": 64001,
                       "startChannel": 1 + 3 * i, "channelCount": 3, "type": 5,
                       "address": a, "priority": 0, "monitor": 1, "deDuplicate": 0}
                      for i, a in enumerate(addresses)],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("slowping.c")])

    def host_warnings():
        return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])
                if w.get("id") == 27]

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert not host_warnings(), f"controllers that answer were dropped: {host_warnings()}"
        time.sleep(0.5)
    lost = [line for line in fppd.log().splitlines() if "Could not ping host" in line]
    assert not lost, "pings that were answered counted as lost:\n" + "\n".join(lost[:10])


def ddp_universes(description, threaded=None, channels=150):
    """co-universes.json: one DDP output to a DdpReceiver on this machine;
    "threaded" is the output's send style (0: sent inline, not by workers)."""
    from show import ddp_output
    config = ddp_output(channels)
    config["channelOutputs"][0]["universes"][0]["description"] = description
    if threaded is not None:
        config["channelOutputs"][0]["threaded"] = threaded
    return config


def reloads(fppd):
    """How many times fppd has loaded the UDP output, startup included (a
    save can reload it more than once)."""
    return fppd.log().count("Calling Init() on UDPOutput output")


def test_reload_waits_for_an_inline_blank(fppd):
    """Saving the E1.31 outputs while another thread sends a blank inline
    (the output thread has gone idle, so "All Lights Off" drives the outputs
    itself) neither frees the output under that send nor wedges.

    The DDP output is unthreaded, so the blank's sendmmsg() runs on the HTTP
    thread, and co_slowsendmmsg.so holds it there 40 ms on every thread but
    the output thread's. Two threads post blanks back to back across 15
    saves.

    Regression: f7aa76e0a. SendBlankingData() sent inline holding no output
    lock, and the reload, which excluded only the output thread, deleted the
    UDPOutput while the blank was inside its SendMessages(): a
    heap-use-after-free.
    """
    import threading

    from ddp import DdpReceiver

    fppd.write("config/co-universes.json", ddp_universes("a", threaded=0))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(150):
        fppd.start(preload=[shims.build("co_slowsendmmsg.c")], extra_env={
            "CO_SLOWSENDMMSG_THREAD": "!FPP-ChannelOut", "CO_SLOWSENDMMSG_MS": "40"})
        time.sleep(4)  # nothing is lit: the output thread winds down and exits
        stop = threading.Event()
        errors = []

        def blank():
            while not stop.is_set():
                try:
                    fppd.command("All Lights Off", timeout=20)
                except Exception as e:  # noqa: BLE001 -- reported below
                    errors.append(e)
                    return

        threads = [threading.Thread(target=blank, daemon=True) for _ in range(2)]
        for t in threads:
            t.start()
        try:
            for i in range(15):
                time.sleep(1.1)  # a save in a later second, as a person makes it
                fppd.check_alive()
                fppd.write("config/co-universes.json", ddp_universes(f"save {i}", threaded=0))
        finally:
            stop.set()
            for t in threads:
                t.join(30)
        fppd.check_alive()
        assert not errors, f"All Lights Off failed: {errors[0]}"
    assert reloads(fppd) >= 16, f"only {reloads(fppd) - 1} reloads for 15 saves"


def test_reload_does_not_lose_a_send_workers_shutdown(fppd):
    """Saving the E1.31 outputs replaces a threaded output whose send worker
    is just about to wait for work, and output carries on after every save.

    co_slowcondwait.so holds a send worker 25 ms between finishing a send
    and waiting for the next, with the work mutex held: the window a worker
    finishing a slow send to a dead controller sits in, and the moment a
    reload gets outputThreadLock. Ten saves, each followed by frames.

    Regression: e354df642. ~UDPOutput cleared runWorkThreads and notified
    without workMutex, and the worker waited with no predicate: a worker in
    that window missed the notify and slept forever, while the destructor
    spun on it holding outputThreadLock. The reload wedged and no frame was
    sent again.
    """
    from ddp import DdpReceiver

    fppd.write("config/co-universes.json", ddp_universes("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    with DdpReceiver(150) as rx:
        fppd.start(preload=[shims.build("co_slowcondwait.c")], extra_env={
            "CO_SLOWCONDWAIT_THREAD": "FPP-UDPWork", "CO_SLOWCONDWAIT_MS": "25"})
        fppd.request("PUT", "/overlays/range/1-150", {"Value": 42})
        assert rx.wait_frames(5, timeout=10), "no DDP frames before the first save"
        for i in range(10):
            time.sleep(1.1)  # a save in a later second, as a person makes it
            fppd.write("config/co-universes.json", ddp_universes(f"save {i}"))
            time.sleep(0.5)
            since = time.monotonic()
            assert rx.wait_frames(5, timeout=5, since=since), \
                f"no DDP frames within 5 s of save {i + 1}: the reload wedged"
    assert reloads(fppd) >= 11, f"only {reloads(fppd) - 1} reloads for 10 saves"


def test_a_controller_that_stops_answering_loses_all_its_universes(fppd):
    """A controller configured as three single-universe E1.31 entries that
    never answers a ping (co_net_noecho.so hides its replies; nothing
    answers its HTTP probe either) is dropped from the output for all three
    universes, not just the first. A fourth universe, to a controller that
    answers, keeps sending (and shows the listeners hear fppd).

    Regression: 16a12ff2f. PingManager keeps one callback per host, and
    UDPOutput registered one per entry, so only the first entry's universe
    was ever marked down: universes 2 and 3 kept sending to the dead
    controller.
    """
    from packets import E131_PORT, parse_e131

    dead, alive = "127.0.0.7", "127.0.0.8"
    entries = [(u, dead) for u in (1, 2, 3)] + [(4, alive)]
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 2040,
        "universes": [{"active": 1, "description": f"universe {u}", "id": u,
                       "startChannel": 1 + 510 * (u - 1), "channelCount": 510, "type": 1,
                       "address": a, "priority": 0, "monitor": 1, "deDuplicate": 0}
                      for u, a in entries],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")

    def universes(listener, since):
        with listener.lock:
            sent = [parse_e131(p) for t, p in listener.packets if t >= since]
        return sorted({p["universe"] for p in sent if p})

    with Listener(E131_PORT, host=dead) as to_dead, Listener(E131_PORT, host=alive) as to_alive:
        fppd.start(preload=[shims.build("co_net_noecho.c")], extra_env={"CO_NOECHO_ADDR": dead})
        fppd.command("Test Start", "100", "RGB Cycle", "1-2040", "R-G-B")
        fppd.wait_for(lambda: "removing from output" in fppd.log(), timeout=60, interval=0.5,
                      what="fppd to drop the controller")
        time.sleep(1)
        since = time.monotonic()
        time.sleep(3)
        assert universes(to_alive, since) == [4], "the controller that answers stopped getting data"
        assert not universes(to_dead, since), \
            f"universes {universes(to_dead, since)} still sent to the dropped controller"


def test_running_out_of_sockets_does_not_end_fppd(fppd):
    """When fppd can't open a socket for an output (out of descriptors:
    co_net_failsock.so fails the output thread's UDP socket() calls with
    EMFILE for two seconds), it logs the failure and carries on.

    Regression: 43986b412. UDPOutput::createSocket() called exit(1) when
    socket() failed, and the whole show stopped.
    """
    from ddp import DdpReceiver

    flag = os.path.join(fppd.media, "tmp", "failsock")
    fppd.write("config/co-universes.json", ddp_universes("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    open(flag, "w").close()  # the output thread makes its socket on its first frame
    with DdpReceiver(150):
        fppd.start(preload=[shims.build("co_net_failsock.c")], extra_env={
            "CO_FAILSOCK_FLAG": flag, "CO_FAILSOCK_THREAD": "FPP-ChannelOut"})
        fppd.request("PUT", "/overlays/range/1-150", {"Value": 42})
        time.sleep(2)
        os.unlink(flag)
        time.sleep(1)
        assert fppd.get("/fppd/status")["status_name"]
        assert "Error opening datagram socket" in fppd.log(), "the socket() failure was never hit"


def test_a_udp_output_that_fails_to_load_leaves_multisync_watching_addresses(fppd):
    """A UDP output whose config can't be read (a universe type that isn't
    a number) fails to load without taking MultiSync's network callback
    with it: an address added afterwards still shows up as this player's in
    /api/fppd/multiSyncSystems.

    Regression: e354df642. networkCallbackId started at 0, which is a real
    id (the first callback registered, MultiSync's); Init() threw before
    registering its own, and the destructor removed MultiSync's.
    """
    import subprocess

    def ip(*args):
        return subprocess.run(["ip", *args], capture_output=True, text=True)

    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "universes": [{"active": 1, "description": "bad", "id": 1, "startChannel": 1,
                       "channelCount": 510, "type": "x", "address": "127.0.0.2",
                       "priority": 0, "monitor": 0, "deDuplicate": 0}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    ip("link", "del", "fpptd3")
    if ip("link", "add", "fpptd3", "type", "dummy").returncode:
        pytest.skip("cannot add a dummy interface")
    try:
        ip("link", "set", "fpptd3", "up")
        fppd.start()

        def addresses():
            out = []
            for s in fppd.get("/fppd/multiSyncSystems").get("systems", []):
                if s.get("local"):
                    out.append(s.get("address"))
            return out

        time.sleep(2)
        assert "Could not initialize output type UDPOutput" in fppd.log(), "the output's Init() didn't fail"
        assert "10.68.0.1" not in addresses()
        ip("addr", "add", "10.68.0.1/24", "dev", "fpptd3")
        fppd.wait_for(lambda: "10.68.0.1" in addresses(), timeout=10, interval=0.5,
                      what="the new address among this player's systems")
    finally:
        ip("link", "del", "fpptd3")


def test_a_controller_name_that_stops_resolving_is_retried(fppd):
    """A controller whose name resolves when the output starts and fails at
    the next lookup (the startup pings re-request it) stays a ping target:
    the ping thread looks its name up again within a ping period, rather
    than the controller being dropped for good.

    Regression: 1705b8e89 (NW-7). addPeriodicPing() dropped a target whose
    name failed to resolve, and nothing looked it up again: a controller
    whose name didn't resolve for a moment stayed out of the output until
    fppd restarted. (slowgai.so answers the first lookup and fails every
    later one, recording those made on the ping threads; 100 ms each here,
    so the ping thread isn't held up -- test_a_name_lookup_does_not_hold_up
    _the_ping_thread is about that.)"""
    marker = os.path.join(fppd.media, "tmp", "slowgai.log")
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 3,
        "universes": [{"active": 1, "description": "controller by name", "id": 1,
                       "startChannel": 1, "channelCount": 3, "type": 5,
                       "address": "slow.invalid", "priority": 0, "monitor": 1, "deDuplicate": 0}],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("slowgai.c")],
               extra_env={"SLOWGAI_NAME": "slow.invalid", "SLOWGAI_FIRST": "127.0.0.2",
                          "SLOWGAI_FILE": marker, "SLOWGAI_MS": "100"})
    # the first retry is a ping period (15 s) after the output started
    fppd.wait_for(lambda: os.path.exists(marker), timeout=40, interval=0.5,
                  what="the ping thread to look slow.invalid up again")


def test_a_name_lookup_does_not_hold_up_the_ping_thread(fppd):
    """A controller whose name stops resolving after the output starts has
    its name looked up again once a ping period, and a lookup that stalls
    (no reachable DNS server: slowgai.so holds it 40 s) holds up neither the
    other pings nor fppd's stop: SIGTERM during the retry lookup exits in a
    few seconds.

    Regression: 31dddee59. 1705b8e89 kept such a target and retried its
    lookup inline on the ping thread, at the top of each pass: while it
    stalled no ping was sent, answered or timed out, and Cleanup()'s join of
    the ping thread waited for the lookup to finish.
    """
    import os
    marker = os.path.join(fppd.media, "tmp", "slowgai.log")
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 3,
        "universes": [{"active": 1, "description": "controller by name", "id": 1,
                       "startChannel": 1, "channelCount": 3, "type": 5,
                       "address": "slow.invalid", "priority": 0, "monitor": 1, "deDuplicate": 0}],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("slowgai.c")],
               extra_env={"SLOWGAI_NAME": "slow.invalid", "SLOWGAI_FIRST": "127.0.0.2",
                          "SLOWGAI_FILE": marker, "SLOWGAI_MS": "40000"})
    # the first retry is a ping period (15 s) after the output started
    fppd.wait_for(lambda: os.path.exists(marker), timeout=30, interval=0.2,
                  what="the ping retry's lookup of slow.invalid")
    began = time.monotonic()
    rc = fppd.stop(timeout=60)
    took = time.monotonic() - began
    fppd.exit_expected = True
    assert took < 10, f"fppd took {took:.1f} s to stop: it waited for the stalled lookup"
    assert rc == 0, f"fppd exited {rc}\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


class EchoRequests:
    """Counts the ICMP echo requests (pings) that reach `address` on this
    machine, from a raw socket that sees every ICMP packet received."""

    def __init__(self, address):
        import socket
        import threading
        self.address = socket.inet_aton(address)
        self.times = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
        self.sock.settimeout(0.2)
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        import socket
        while self.running:
            try:
                pkt = self.sock.recv(65536)
            except socket.timeout:
                continue
            except OSError:
                break
            ihl = (pkt[0] & 0x0F) * 4
            if pkt[16:20] == self.address and len(pkt) > ihl and pkt[ihl] == 8:
                self.times.append(time.monotonic())

    def count_since(self, start):
        return sum(1 for t in list(self.times) if t >= start)

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def test_failing_sends_keep_one_ping_in_flight_per_controller(fppd):
    """A controller that answers its pings but whose channel data cannot be
    sent is pinged again on every third failed frame, and once per
    universe. Those re-requests share the ping already in flight: ten
    universes to one controller, with every send to it failing (sendfail.so)
    for ten seconds of test mode, put a few pings on the wire, not hundreds.
    slowping.so holds the ping thread up a second after each wake-up, so
    each ping is in flight that long.

    Regression: 5bccf7ffd. Each re-request pushed the target onto the ping
    list again and sent another ping, with no check for one in flight: about
    70 pings a second here, each copy with its own timeout and callback,
    which on a device ran fppd out of file descriptors.
    """
    address = "127.0.0.2"
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 30,
        "universes": [{"active": 1, "description": f"universe {n}", "id": n,
                       "startChannel": 1 + 3 * (n - 1), "channelCount": 3, "type": 1,
                       "address": address, "priority": 0, "monitor": 1, "deDuplicate": 0}
                      for n in range(1, 11)],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    with EchoRequests(address) as pings:
        fppd.start(preload=[shims.build("slowping.c"), shims.build("sendfail.c")],
                   extra_env={"SLOWPING_MS": "1000"})
        fppd.command("Test Start", "100", "RGB Cycle", "1-30", "R-G-B")
        time.sleep(3)
        start = time.monotonic()
        time.sleep(10)
        sent = pings.count_since(start)
    failed = [line for line in fppd.log().splitlines() if "failed for UDP output" in line]
    assert failed, "the sends to the controller never failed: sendfail.so did not engage"
    assert sent <= 40, f"{sent} pings to one controller in 10 s"
    # c70531ab8: the log names the controller by its address, not by the
    # hex key the sockets are filed under.
    assert all("(IP: 127.0.0.2 " in line for line in failed), failed[:2]


def test_reload_waits_for_a_running_ping_callback(fppd):
    """Saving the output config while the ping thread is inside a
    controller's ping callback waits for that callback to finish before the
    output, and its ping, are freed. slowcb.so holds the ping thread for 3 s
    in the callback that puts a controller back in the output (its "Could
    ping host" log line); the config is saved during that time. (fppd pings
    every 15 s and needs three failed pings to drop the controller first, so
    this takes a minute or so.)

    Regression: 81eb0b65c. removePeriodicPing() took only the target list's
    lock, so the reload deleted the ping target, and the output its callback
    belonged to, while the callback ran; the ping thread then wrote into the
    freed target (a heap-use-after-free under ASan).
    """
    import os
    import subprocess

    address = "10.77.0.2"   # nothing answers here until the test adds it
    mark = os.path.join(fppd.media, "tmp", "in-callback")

    def config(description):
        return {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 3,
            "universes": [{"active": 1, "description": description, "id": 1,
                           "startChannel": 1, "channelCount": 3, "type": 1,
                           "address": address, "priority": 0, "monitor": 1, "deDuplicate": 0}],
        }]}

    def host_warnings():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", []) if w.get("id") == 27]

    fppd.write("config/co-universes.json", config("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start(preload=[shims.build("slowcb.c")],
               extra_env={"SLOWCB_MARK": mark, "SLOWCB_MS": "3000"})
    fppd.wait_for(host_warnings, timeout=120, interval=1,
                  what="fppd to give up on the unreachable controller")
    try:
        subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], check=True)
        fppd.wait_for(lambda: os.path.exists(mark), timeout=40, interval=0.05,
                      what="the ping thread to run the controller's callback")
        fppd.write("config/co-universes.json", config("b"))
        time.sleep(5)
        fppd.check_alive()
        fppd.get("/fppd/status")
    finally:
        subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"])


def test_dead_controller_is_dropped_while_other_icmp_arrives(fppd):
    """A controller that stops answering is dropped from the output with a
    warning even while other ICMP keeps arriving: here a port-unreachable
    every 50 ms, for UDP this test sends to a closed port, as a device
    getting output on a port it doesn't listen on sends back. fppd's raw
    ping socket receives all of it. (It takes three failed pings and a failed
    HTTP probe; fppd pings three times as it starts.)

    Regression: 5c1ef6c76. Pings were timed out only on a pass of the ping
    thread that had seen no ICMP for 250 ms, so with ICMP arriving every
    50 ms the dead controller was never timed out and never reported.
    """
    import socket
    import threading

    address = "10.77.0.2"   # nothing answers here
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 3,
        "universes": [{"active": 1, "description": "dead controller", "id": 1,
                       "startChannel": 1, "channelCount": 3, "type": 1, "address": address,
                       "priority": 0, "monitor": 1, "deDuplicate": 0}],
    }]})
    fppd.settings(DisableFakeNetworkBridges="1")
    # a port nothing listens on: bind one, note it, close it
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    closed = probe.getsockname()[1]
    probe.close()
    sending = threading.Event()
    sending.set()

    def unreachables():
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            while sending.is_set():
                s.sendto(b"x", ("127.0.0.1", closed))
                time.sleep(0.05)

    t = threading.Thread(target=unreachables, daemon=True)
    t.start()
    try:
        fppd.start()
        fppd.wait_for(lambda: [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                               if w.get("id") == 27],
                      timeout=60, interval=1, what="fppd to give up on the dead controller")
    finally:
        sending.clear()
        t.join()


def bad_generic_udp_then_watched_universe(fppd, address):
    """A GenericUDP output with a wrong-typed field (a hand edit: "port" as
    a list), loaded while there is no UDP output, then an E1.31 config with
    one universe whose controller at `address` is monitored and down."""
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "GenericUDP", "enabled": 1, "startChannel": 1, "channelCount": 3,
        "address": "127.0.0.1", "port": [5000], "tokens": "{data}"}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 10, "channelCount": 3,
        "universes": [{"active": 1, "description": "watched", "id": 1, "startChannel": 10,
                       "channelCount": 3, "type": 1, "address": address,
                       "priority": 0, "monitor": 1, "deDuplicate": 0}]}]})

    def loaded():
        w = " ".join(fppd.get("/fppd/status").get("warnings", []))
        return "Could not initialize output type UDPOutput" in w or "Could not create a network output" in w
    fppd.wait_for(loaded, timeout=15, what="the E1.31 config to load")


def test_a_generic_udp_output_that_throws_leaves_no_ping_behind(fppd):
    """A UDP output rebuilt with a GenericUDP output whose config can't be
    read leaves no periodic ping on a freed output: fppd stays clean when
    the monitored controller comes up and answers the next ping (every
    15 s).

    Regression: 83127b014. The GenericUDP factory threw from UDPOutput::Init()
    after the pings were registered; the loader deleted the output without
    Close(), which was where they were removed, and the next answered ping
    ran OnPingResult() in the freed output (ASan heap-use-after-free at
    --failedCount). Proved for the destructor half alone with a revert
    control: master with only the factory guard reverted passes.
    """
    import subprocess
    address = "10.77.0.3"  # nothing answers here until the test adds it
    bad_generic_udp_then_watched_universe(fppd, address)
    try:
        subprocess.run(["ip", "addr", "add", address + "/32", "dev", "lo"], check=True)
        time.sleep(20)  # past the next periodic ping, which is now answered
        fppd.check_alive()
    finally:
        subprocess.run(["ip", "addr", "del", address + "/32", "dev", "lo"])


def test_a_generic_udp_output_that_throws_leaves_the_universes_running(fppd):
    """A GenericUDP output whose config can't be read is skipped, with a
    warning naming why; the E1.31 universes beside it still load.

    Regression: 83127b014. The GenericUDP factory's exception escaped
    UDPOutput::Init(), so every E1.31/DDP universe failed with it ("Could
    not initialize output type UDPOutput") at each rebuild.
    """
    bad_generic_udp_then_watched_universe(fppd, "10.77.0.4")
    warnings = fppd.get("/fppd/status").get("warnings", [])
    assert not any("Could not initialize output type UDPOutput" in w for w in warnings), warnings
    assert any("Could not create a network output" in w for w in warnings), warnings


def test_output_comes_back_once_sockets_can_be_opened_again(fppd):
    """When the output's socket couldn't be opened (EMFILE for two seconds,
    from co_net_failsock.so), output to that controller comes back once
    sockets can be opened again.

    Regression: 60c4defff. 43986b412 made createSocket() return -1 instead
    of exiting, but the -1 was stored in the destination's socket list, which
    was then non-empty, so findOrCreateSocket() never made another. Every
    send failed with EBADF, which doesn't trigger the EAGAIN rotation, and
    the controller stayed dark, with no banner, until a config save.
    """
    import os
    from ddp import DdpReceiver

    flag = os.path.join(fppd.media, "tmp", "failsock")
    fppd.write("config/co-universes.json", ddp_universes("a"))
    fppd.settings(DisableFakeNetworkBridges="1")
    open(flag, "w").close()  # the output thread makes its socket on its first frame
    with DdpReceiver(150) as rx:
        fppd.start(preload=[shims.build("co_net_failsock.c")], extra_env={
            "CO_FAILSOCK_FLAG": flag, "CO_FAILSOCK_THREAD": "FPP-ChannelOut"})
        fppd.request("PUT", "/overlays/range/1-150", {"Value": 42})
        time.sleep(2)
        assert "Error opening datagram socket" in fppd.log(), "the socket() failure was never hit"
        os.unlink(flag)
        since = time.monotonic()
        assert rx.wait_frames(5, timeout=10, since=since), \
            "no DDP frames within 10 s of sockets becoming available again"


def test_channel_outputs_enabled_means_universe_outputs(fppd):
    """channelOutputsEnabled, in /fppd/status and in the local system's
    /fppd/multiSyncSystems entry, says whether there are E1.31/DDP/Art-Net
    outputs (what the MultiSync page shows it for): false with only an Other
    output loaded, true once a co-universes.json output is saved.

    Regression: 6cc92025f. It reported any channel output at all, so a
    player driving only a serial or control channel output showed as
    sending universes.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ControlChannel", "enabled": 1, "startChannel": 1, "channelCount": 1,
        "values": []}]})
    fppd.start()

    def enabled():
        local = [s for s in fppd.get("/fppd/multiSyncSystems")["systems"] if s.get("local")]
        return (fppd.get("/fppd/status").get("channelOutputsEnabled"),
                local[0].get("channelOutputsEnabled") if local else "no local system")

    fppd.wait_for(lambda: "Calling Init() on ControlChannel output" in fppd.log(),
                  what="the control channel output to load")
    assert enabled() == (False, False), f"with only a control channel output: {enabled()}"
    fppd.write("config/co-universes.json", universes("added"))
    fppd.wait_for(lambda: enabled() == (True, True), timeout=10,
                  what="channelOutputsEnabled once a universe output is loaded")


def test_control_channel_hands_its_value_to_the_preset(fppd):
    """A control channel's preset can use the value that fired it: setting
    the channel to 128 runs a URL command whose URL carries
    %CHANNEL_VALUE%, %CHANNEL_VALUE255% and %CHANNEL_VALUE100%, and the
    request arrives as 128, 128 and 50.

    Regression: 18bd13458 (the feature). Before it the preset ran with no
    keywords, so the URL went out with the placeholders as written.
    """
    import http.server
    import threading

    paths = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    fppd.write("config/co-other.json", {"channelOutputs": [{
        "type": "ControlChannel", "enabled": 1, "startChannel": 1, "channelCount": 1,
        "values": [{"value": 128, "preset": "Level"}]}]})
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "Level", "command": "URL", "presetSlot": 0,
        "args": [f"http://127.0.0.1:{port}/level?v=%CHANNEL_VALUE%&raw=%CHANNEL_VALUE255%"
                 "&pct=%CHANNEL_VALUE100%", "GET", ""]}]})
    try:
        fppd.start()
        fppd.request("PUT", "/overlays/range/1-1", {"Value": 128})
        fppd.wait_for(lambda: paths, timeout=10, what="the preset's URL request")
        assert paths[0] == "/level?v=128&raw=128&pct=50", f"the preset requested {paths[0]}"
    finally:
        srv.shutdown()
        srv.server_close()
