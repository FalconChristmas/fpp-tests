"""The channel output list reloaded under readers on other threads: fppd's
status and MultiSync's own system entry (HasUniverseOutputs()) walk the list
from HTTP and MultiSync threads while a save of the outputs frees what they
walk, and a network change runs MultiSync's callback in between. A TSan build
(run.sh --flavor tsan) is what tells: a report fails the scenario."""

import subprocess
import threading
import time

import pytest

IFACE = "fppnm0"


def outputs(description):
    """co-universes.json: one E1.31 universe to loopback (a UDPOutput, which
    registers a network callback), described as given so a save reloads it."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "universes": [{"active": 1, "description": description, "id": 1, "startChannel": 1,
                       "channelCount": 510, "type": 1, "address": "127.0.0.1", "priority": 0,
                       "monitor": 0, "deDuplicate": 0}]}]}


def ip(*args):
    return subprocess.run(["ip", *args], capture_output=True, text=True)


def test_outputs_reloaded_while_status_and_multisync_read_them(fppd):
    """Saves of the outputs, each reloading (closing and freeing) the E1.31
    output, while two clients poll fppd's status and the MultiSync systems
    list and an address comes and goes on a network interface: every
    request is answered, and (under TSan) nothing races or closes a lock
    cycle.

    Regression: 6a78cd1c7, under TSan. HasUniverseOutputs() walked the list
    with no lock while the reload path freed the instances it walked.

    Regression: c36bb3bcf, under TSan. 6a78cd1c7's lock was held while the
    reload closed the outputs, and a UDP output's Close() takes the network
    callbacks' lock, whose dispatch takes MultiSync's, which is held around
    HasUniverseOutputs() for the systems list: a lock-order cycle (free lock
    -> callbacks -> MultiSync -> free lock), a potential deadlock."""
    ip("link", "del", IFACE)
    r = ip("link", "add", IFACE, "type", "dummy")
    if r.returncode:
        pytest.skip(f"cannot add a dummy interface: {r.stderr.strip()}")
    try:
        ip("link", "set", IFACE, "up")
        fppd.write("config/co-universes.json", outputs("a"))
        fppd.settings(MultiSyncEnabled="1")
        fppd.start()
        errors = []
        stop = threading.Event()

        def poll(path):
            while not stop.is_set():
                try:
                    fppd.get(path, timeout=15)
                except Exception as e:  # report it from the main thread
                    errors.append(f"{path}: {e!r}")
                    return

        threads = [threading.Thread(target=poll, args=(p,), daemon=True)
                   for p in ("/fppd/status", "/fppd/multiSyncSystems")]
        for t in threads:
            t.start()
        try:
            for n in range(6):
                ip("addr", "add", f"10.67.{n}.1/24", "dev", IFACE)
                time.sleep(0.6)
                # A save in a later second each time: the file monitor
                # reloads a changed file at most once a second.
                fppd.write("config/co-universes.json", outputs("b" if n % 2 else "a"))
                time.sleep(1.2)
                ip("addr", "del", f"10.67.{n}.1/24", "dev", IFACE)
        finally:
            stop.set()
            for t in threads:
                t.join(20)
        assert not errors, errors
        assert fppd.get("/fppd/status").get("channelOutputsEnabled") is not None
    finally:
        ip("link", "del", IFACE)
