"""Paced UDP outputs to a controller that can't keep up.

The controller is 10.66.0.2 on a dummy show interface, ethfpp0 (fppd paces
only eth*/en* interfaces). A tbf qdisc on it drains packets at a few Mbps,
so a big frame fills fppd's socket buffer and sends make slow progress, as
they do to a controller paced below what its frames need. The container's
kernel has no fq qdisc, so co_net_popen.so answers fppd's "tc qdisc show"
for ethfpp0 with fq: fppd then takes its kernel-paced send path, and tbf
does the slow draining fq would. Needs NET_ADMIN (run.sh has it).
"""

import contextlib
import os
import subprocess
import time

import pytest

import shims

IFACE = "ethfpp0"
LOCAL = "10.66.0.1"
CONTROLLER = "10.66.0.2"


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


@contextlib.contextmanager
def show_interface(rate="4mbit"):
    """ethfpp0 with LOCAL on it and a tbf qdisc draining at `rate`."""
    run("ip", "link", "del", IFACE)
    r = run("ip", "link", "add", IFACE, "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        for cmd in (("ip", "addr", "add", LOCAL + "/24", "dev", IFACE),
                    ("ip", "link", "set", IFACE, "up"),
                    ("tc", "qdisc", "add", "dev", IFACE, "root", "tbf", "rate", rate,
                     "burst", "16kb", "limit", "20mb")):
            r = run(*cmd)
            if r.returncode:
                pytest.skip(f"{' '.join(cmd)}: {r.stderr.strip()}")
        yield
    finally:
        run("ip", "link", "del", IFACE)


def e131(universes, pacing, description="big controller"):
    """co-universes.json: `universes` E1.31 unicast universes of 510
    channels to CONTROLLER, paced at `pacing` Mbps (0: unpaced)."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1,
        "channelCount": universes * 510, "interface": IFACE, "pacingRate": pacing,
        "universes": [{"active": 1, "description": description, "id": 1, "startChannel": 1,
                       "channelCount": 510, "universeCount": universes, "type": 1,
                       "address": CONTROLLER, "priority": 0, "monitor": 0,
                       "deDuplicate": 0}],
    }]}


def start(fppd, popen_log=None):
    fppd.settings(DisableFakeNetworkBridges="1")
    env = {"CO_FAKEFQ_IFACES": IFACE}
    if popen_log:
        env["CO_POPEN_LOG"] = popen_log
    fppd.start(preload=[shims.build("co_net_popen.c")], extra_env=env)


def workers(fppd):
    n = 0
    task = f"/proc/{fppd.proc.pid}/task"
    for tid in os.listdir(task):
        try:
            with open(f"{task}/{tid}/comm") as f:
                n += f.read().strip() == "FPP-UDPWork"
        except OSError:
            pass
    return n


def test_a_destination_over_its_pacing_rate_keeps_one_send_worker(fppd):
    """A controller paced at 4 Mbps whose frames need about five times that
    keeps a bounded number of send workers: every send runs to the 100 ms
    budget, and frames for it wait or fold into the pending send instead of
    each getting a thread.

    Regression: 1e9a2bbd2. SendData() queued a work item per frame for the
    destination and started a worker for each item past the worker count;
    each blocked on the destination's sendLock behind the slow send, so the
    worker count grew by a few a second until thread creation failed and
    fppd terminated.
    """
    with show_interface():
        fppd.write("config/co-universes.json", e131(200, 4))
        start(fppd)
        fppd.command("Test Start", "100", "RGB Cycle", "1-102000", "R-G-B")
        most = 0
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            most = max(most, workers(fppd))
            time.sleep(0.25)
        log = fppd.log()
        assert "pacing enabled at 4 Mbps" in log, "the output never took the paced send path"
        assert "exceeded time budget" in log, "the sends never ran into their budget"
        assert most <= 3, f"{most} send workers for one destination"


def budget_warnings(fppd):
    return [w.get("message", "") for w in fppd.get("/fppd/status").get("warningInfo", [])
            if w.get("id") == 68]


def test_a_controller_over_its_pacing_rate_raises_a_warning(fppd):
    """A controller whose frames need about five times its pacing rate
    raises warning 68 naming it at the first pacing-budget check (every
    1500 frames, about 75 s of test mode).

    Regression: 2ac813fce. Nothing told the user: the only trace of the
    late and cut-off frames was a log line per frame.
    """
    with show_interface():
        fppd.write("config/co-universes.json", e131(200, 4))
        start(fppd)
        fppd.command("Test Start", "100", "RGB Cycle", "1-102000", "R-G-B")
        fppd.wait_for(lambda: [w for w in budget_warnings(fppd) if f"Controller {CONTROLLER}" in w],
                      timeout=150, interval=2, what="the pacing-budget warning")


def test_the_qdisc_is_looked_up_once_per_load(fppd):
    """Twenty controllers on a paced show interface cost a couple of qdisc
    lookups per output load, not one each: over startup and one save of
    the outputs, "tc qdisc show dev ethfpp0" runs at most four times.

    Regression: 2147f5587. Each destination's first socket asked for the
    interface's qdisc again, and on kernels without the sysfs qdisc file
    that forks tc, on the output thread: about twenty per load.
    """
    def controllers(description):
        return {"channelOutputs": [{
            "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 20 * 510,
            "interface": IFACE, "pacingRate": 90,
            "universes": [{"active": 1, "description": description, "id": n + 1,
                           "startChannel": 1 + 510 * n, "channelCount": 510, "type": 1,
                           "address": f"10.66.0.{n + 2}", "priority": 0, "monitor": 0,
                           "deDuplicate": 0} for n in range(20)],
        }]}

    log = os.path.join(fppd.media, "tmp", "popen.log")
    with show_interface(rate="1gbit"):
        fppd.write("config/co-universes.json", controllers("a"))
        start(fppd, popen_log=log)
        fppd.request("PUT", "/overlays/range/1-10200", {"Value": 42})
        time.sleep(3)
        fppd.write("config/co-universes.json", controllers("b"))
        time.sleep(3)

        def lookups():
            with open(log) as f:
                return [l for l in f if f"qdisc show dev {IFACE}" in l and " -s " not in l]

        assert fppd.log().count("Calling Init() on UDPOutput output") >= 2, "the save never reloaded"
        assert "pacing enabled at 90 Mbps" in fppd.log(), "the output never took the paced path"
        assert len(lookups()) <= 4, f"{len(lookups())} qdisc lookups:\n" + "".join(lookups()[:30])
