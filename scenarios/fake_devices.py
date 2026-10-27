"""Fake controllers on their own network, for fppd's HTTP discovery.

fppd only probes devices it can treat as remote: not loopback, and not an
address on one of its own interfaces. So the devices live in a separate
network namespace, joined to fppd's by a veth pair, each on its own address
with an HTTP server on port 80 (fppd's probe URLs have no port). Each device
is a map of path -> response; an unknown path is a 404.

Needs NET_ADMIN and SYS_ADMIN (run.sh has both); skips otherwise.
"""

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import time

import pytest

NETNS = "fpptest-dev"
HOST_IF, DEV_IF = "fpptdev0", "fpptdev1"
HOST_ADDR = "10.88.0.1"
HOST_ADDR6 = "fd00:88::1"  # the host end, for devices on an IPv6 address
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_device_server.py")


def _ip(*args, ns=None):
    cmd = (["ip", "netns", "exec", ns] if ns else []) + ["ip", *args]
    return subprocess.run(cmd, capture_output=True, text=True)


def page(body, status=200, ctype="text/html", headers=None):
    """One response: a body (str, or anything JSON-able), status and type."""
    if not isinstance(body, str):
        body, ctype = json.dumps(body), "application/json"
    return {"status": status, "type": ctype, "body": body, "headers": headers or {}}


def drop():
    """A response that is no response: the connection is closed unanswered."""
    return {"drop": True, "status": 0, "type": "", "body": "", "headers": {}}


def requests_seen(address):
    """The requests a fake device was sent so far, as "GET /path?query"."""
    out = subprocess.run(["curl", "-s", "-m", "5", f"http://{address}/_requests"],
                         capture_output=True, text=True)
    assert out.returncode == 0, f"{address}/_requests: curl exit {out.returncode}"
    return json.loads(out.stdout)


@contextlib.contextmanager
def device_network(addresses):
    """A network namespace holding `addresses`, joined to fppd's by a veth.
    Yields a function that starts a command inside it (a Popen); every
    process started that way is killed, and the namespace removed, on exit."""
    _ip("netns", "del", NETNS)
    r = _ip("netns", "add", NETNS)
    if r.returncode:
        pytest.skip(f"cannot add a network namespace: {r.stderr.strip()}")
    procs = []
    try:
        for args in (("link", "add", HOST_IF, "type", "veth", "peer", "name", DEV_IF),
                     ("link", "set", DEV_IF, "netns", NETNS),
                     ("addr", "add", HOST_ADDR + "/24", "dev", HOST_IF),
                     ("link", "set", HOST_IF, "up")):
            r = _ip(*args)
            assert r.returncode == 0, f"ip {' '.join(args)}: {r.stderr}"
        _ip("link", "set", "lo", "up", ns=NETNS)
        if any(":" in a for a in addresses):
            r = _ip("addr", "add", HOST_ADDR6 + "/64", "dev", HOST_IF, "nodad")
            assert r.returncode == 0, f"ip addr add {HOST_ADDR6}: {r.stderr}"
        for addr in addresses:
            if ":" in addr:  # nodad: usable at once, not tentative for a second
                _ip("addr", "add", addr + "/64", "dev", DEV_IF, "nodad", ns=NETNS)
            else:
                _ip("addr", "add", addr + "/24", "dev", DEV_IF, ns=NETNS)
        _ip("link", "set", DEV_IF, "up", ns=NETNS)

        def run(*cmd):
            p = subprocess.Popen(["ip", "netns", "exec", NETNS, *cmd], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True)
            procs.append(p)
            return p
        yield run
    finally:
        for p in procs:
            p.kill()
            p.wait()
        _ip("netns", "del", NETNS)
        _ip("link", "del", HOST_IF)


def wait_ready(proc, address, port=80):
    """Wait for a server started with device_network()'s run() to print
    "ready" and for `address` to answer HTTP across the veth."""
    line = proc.stdout.readline()
    assert line.strip() == "ready", \
        f"fake device server: {line}{proc.stdout.read() if proc.poll() is not None else ''}"
    deadline = time.monotonic() + 10
    host = f"[{address}]" if ":" in address else address
    while subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "1",
                          f"http://{host}:{port}/"]).returncode:
        assert time.monotonic() < deadline, f"{address} never answered"
        time.sleep(0.2)


@contextlib.contextmanager
def fake_devices(devices):
    """devices: {address: {path: page(...)}}. Yields once every server
    answers."""
    with device_network(devices) as run, tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump(devices, f)
        f.flush()
        wait_ready(run(sys.executable, "-I", SERVER, f.name), next(iter(devices)))
        yield
