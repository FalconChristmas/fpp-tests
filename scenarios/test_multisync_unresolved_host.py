"""A MultiSync system whose hostname fppd cannot turn into an IPv4 address."""

import json
import sys
import tempfile
import time

from fake_devices import SERVER, device_network, page

NAME = "v6only.fpptest"
ADDR = "fd00:88::50"


def test_a_host_with_no_ipv4_address_is_listed_without_crashing_fppd(fppd):
    """A hostname that resolves only to an IPv6 address answers fppd's HTTP
    discovery (curl reaches it), but fppd's own lookup is IPv4-only and
    fails. The system is still listed, under its name, and fppd keeps
    running.

    Regression: d3bca6b56. MultiSyncSystem::update() split the address into
    four octets after a failed lookup and read parts[1]..parts[3] of a
    one-element vector, crashing fppd."""
    with device_network([ADDR]) as run, tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump({ADDR: {"/": page("<html><head><title>Some Controller</title></head></html>")}}, f)
        f.flush()
        proc = run(sys.executable, "-I", SERVER, f.name)
        assert proc.stdout.readline().strip() == "ready"
        with open("/etc/hosts", "a") as h:
            h.write(f"{ADDR} {NAME}\n")
        fppd.settings(MultiSyncHTTPSubnets=NAME, LogLevel_Sync="debug")
        fppd.start()
        fppd.wait_for(lambda: "Error looking up hostname" in fppd.log(), timeout=30, interval=0.5,
                      what="the failed IPv4 lookup of the host's name")
        time.sleep(1)
        names = {s["address"] for s in fppd.get("/fppd/multiSyncSystems")["systems"]}
        assert NAME in names, f"{NAME} not listed: {sorted(names)}"
