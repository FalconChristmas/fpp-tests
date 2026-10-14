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
SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_device_server.py")


def _ip(*args, ns=None):
    cmd = (["ip", "netns", "exec", ns] if ns else []) + ["ip", *args]
    return subprocess.run(cmd, capture_output=True, text=True)


def page(body, status=200, ctype="text/html", headers=None):
    """One response: a body (str, or anything JSON-able), status and type."""
    if not isinstance(body, str):
        body, ctype = json.dumps(body), "application/json"
    return {"status": status, "type": ctype, "body": body, "headers": headers or {}}


@contextlib.contextmanager
def fake_devices(devices):
    """devices: {address: {path: page(...)}}. Yields once every server
    answers; removes the namespace (and with it the veth) afterwards."""
    _ip("netns", "del", NETNS)
    r = _ip("netns", "add", NETNS)
    if r.returncode:
        pytest.skip(f"cannot add a network namespace: {r.stderr.strip()}")
    proc = None
    cfg = None
    try:
        for args in (("link", "add", HOST_IF, "type", "veth", "peer", "name", DEV_IF),
                     ("link", "set", DEV_IF, "netns", NETNS),
                     ("addr", "add", HOST_ADDR + "/24", "dev", HOST_IF),
                     ("link", "set", HOST_IF, "up")):
            r = _ip(*args)
            assert r.returncode == 0, f"ip {' '.join(args)}: {r.stderr}"
        _ip("link", "set", "lo", "up", ns=NETNS)
        for addr in devices:
            _ip("addr", "add", addr + "/24", "dev", DEV_IF, ns=NETNS)
        _ip("link", "set", DEV_IF, "up", ns=NETNS)

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(devices, f)
            cfg = f.name
        proc = subprocess.Popen(["ip", "netns", "exec", NETNS, sys.executable, "-I", SERVER, cfg],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = proc.stdout.readline()
        assert line.strip() == "ready", f"fake device server: {line}{proc.stdout.read() if proc.poll() is not None else ''}"
        # The veth needs a moment before the first packet crosses it.
        deadline = time.monotonic() + 10
        first = next(iter(devices))
        while subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "1", f"http://{first}/"]).returncode:
            assert time.monotonic() < deadline, f"{first} never answered"
            time.sleep(0.2)
        yield
    finally:
        if proc:
            proc.kill()
            proc.wait()
        if cfg:
            os.unlink(cfg)
        _ip("netns", "del", NETNS)
        _ip("link", "del", HOST_IF)
