"""A device found over mDNS at an IPv6 address.

The `avahi` fixture (test_mdns.py) gives the run an avahi-daemon of its own.
The device is a fake WLED in its own network namespace (fake_devices.py) on
an IPv6 address only: a unique-local one, or a link-local one, reachable
only through the interface it was found on. Its service and that address
are published through the daemon with avahi-publish -- as if heard from the
network -- so fppd's browser resolves the service to the IPv6 address and
probes it over HTTP.
"""

import json
import subprocess
import sys
import tempfile
import time

import pytest

from fake_devices import DEV_IF, HOST_IF, SERVER, _ip, device_network, page
from test_mdns import avahi  # noqa: F401 -- fixture

NAME = "wled-v6"
PAGES = {
    "/": page("<html><head><title>WLED UI</title></head><body></body></html>"),
    "/json/info": page({"ver": "0.14.4", "name": NAME, "arch": "esp32", "mac": "a0b1c2d3e4f6"}),
}
# address -> how fppd lists it: a link-local one with the zone (interface)
# it was resolved on, without which it can't be reached
ADDRS = {"fd00:88::2": "fd00:88::2", "fe80::2": "fe80::2%" + HOST_IF}


def systems(fppd):
    return {s["address"]: s for s in fppd.get("/fppd/multiSyncSystems")["systems"]
            if not s.get("local")}


@pytest.fixture(params=list(ADDRS), ids=["unique-local", "link-local"])
def wled6(request, avahi):
    """The WLED on an IPv6 address, serving its pages on port 80, with its
    service and host record published. Yields the address fppd should list."""
    addr = request.param
    link_local = addr.startswith("fe80")
    with device_network([addr]) as run, tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        _ip("link", "set", HOST_IF, "multicast", "on")
        # a link-local address is bound, and reached, through its interface
        json.dump({addr + "%" + DEV_IF if link_local else addr: PAGES}, f)
        f.flush()
        proc = run(sys.executable, "-I", SERVER, f.name)
        assert proc.stdout.readline().strip() == "ready", \
            f"fake device server: {proc.stdout.read() if proc.poll() is not None else ''}"
        url = f"http://[{addr}%25{HOST_IF}]/" if link_local else f"http://[{addr}]/"
        deadline = time.monotonic() + 10
        while subprocess.run(["curl", "-g", "-s", "-o", "/dev/null", "-m", "1", url]).returncode:
            assert time.monotonic() < deadline, f"{url} never answered"
            time.sleep(0.2)
        pubs = [subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for cmd in (
            ["avahi-publish", "-a", "-R", f"{NAME}.local", addr],
            ["avahi-publish", "-s", "-H", f"{NAME}.local", NAME, "_wled._tcp", "80", "mac=a0b1c2d3e4f6"])]
        try:
            deadline = time.monotonic() + 15
            while subprocess.run(["avahi-resolve-host-name", "-6", f"{NAME}.local"],
                                 capture_output=True, text=True).stdout.split()[-1:] != [addr]:
                assert time.monotonic() < deadline, f"{NAME}.local never resolved to {addr}"
                time.sleep(0.25)
            yield ADDRS[addr]
        finally:
            for p in pubs:
                p.terminate()
                p.wait()


def test_a_device_at_an_ipv6_address_is_probed_and_listed(wled6, fppd):
    """fppd probes the WLED at its IPv6 address -- bracketed in the URL, as
    curl requires, with a link-local address's zone carried along -- and
    lists it as a WLED with the version its /json/info gives (so both its
    front page and its API were fetched).

    Regression: 1c73c7155. The probe URL was "http://" + address, so for
    an IPv6 literal curl was given "http://fd00:88::2" (host "fd00", a bad
    port) and the request never went out: the device was never listed. A
    link-local address also lost the interface it was found on."""
    addr = wled6
    fppd.settings(LogLevel_Sync="debug")
    fppd.start()
    fppd.wait_for(lambda: f"MDNS discovered new host {addr}" in fppd.log(), timeout=30,
                  interval=0.5, what=f"fppd to resolve the WLED's service to {addr}")
    s = fppd.wait_for(lambda: systems(fppd).get(addr), timeout=20, interval=0.5,
                      what=f"the WLED at {addr} to be listed")
    assert s["typeId"] == 0xFB and s["version"] == "0.14.4", s
