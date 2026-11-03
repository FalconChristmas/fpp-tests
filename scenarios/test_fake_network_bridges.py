"""The "fake" network bridges: with no input configured, fppd still listens
on the E1.31 and DDP ports, to warn about data sent to it by mistake
("Received DDP data from ..."), unless DisableFakeNetworkBridges is set."""

import socket
import time

from packets import DDP_PORT, E131_PORT, ddp, e131, send
from test_command_socket import send as command


def udp_sockets():
    """Local port -> rx_queue bytes for each UDP socket in this network
    namespace (/proc/net/udp)."""
    ports = {}
    with open("/proc/net/udp") as f:
        next(f)
        for line in f:
            fields = line.split()
            ports[int(fields[1].split(":")[1], 16)] = int(fields[4].split(":")[1], 16)
    return ports


def ddp_warnings(fppd):
    return [w for w in fppd.get("/fppd/status").get("warnings", [])
            if w.startswith("Received DDP data from")]


def ddp_query(ident):
    """A DDP query (flags: version 1 + query) to device id `ident`: what
    xLights and other controllers broadcast to find DDP devices."""
    return bytes([0x40 | 0x02, 0, 0x01, ident]) + bytes(6)


def test_ddp_discovery_packets_raise_no_warning(fppd):
    """With no input configured, DDP queries (to the config, status and
    "all devices" ids) arriving on port 4048 are passed over without a
    warning; a DDP pixel-data packet from the same sender still raises
    "Received DDP data from 127.0.0.1".

    Regression: 98fb331d4. Any packet on the DDP port counted as stray
    data, so every FPP on a network where something searched for DDP
    devices warned that it was receiving DDP data."""
    fppd.start()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for _ in range(3):
            for ident in (250, 251, 255):
                sock.sendto(ddp_query(ident), ("127.0.0.1", DDP_PORT))
        fppd.wait_for(lambda: udp_sockets().get(DDP_PORT) == 0, timeout=5,
                      what="fppd to read the queries off the DDP socket")
        time.sleep(0.5)
        assert not ddp_warnings(fppd), ddp_warnings(fppd)

        sock.sendto(ddp(0, bytes([0x10]) * 30), ("127.0.0.1", DDP_PORT))
        fppd.wait_for(lambda: ddp_warnings(fppd), timeout=5,
                      what="the warning about the DDP pixel data")
    finally:
        sock.close()


def test_disable_fake_network_bridges_closes_the_listeners(fppd):
    """DisableFakeNetworkBridges=1 and no input configured: fppd holds
    neither UDP 5568 (E1.31) nor 4048 (DDP), so another program can take
    them, and E1.31 sent there raises no warning. Setting it back to 0 opens
    them again.

    Regression: ced1cf5ab. The fake listeners opened whenever fppd wasn't in
    bridge mode, with no way to turn them off for software of one's own
    that needs those ports."""
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    held = {p for p in (E131_PORT, DDP_PORT) if p in udp_sockets()}
    assert not held, f"fppd listens on UDP {sorted(held)} with the fake bridges disabled"
    send([e131(1, bytes(10))], E131_PORT)
    time.sleep(1)
    warned = [w for w in fppd.get("/fppd/status").get("warnings", []) if w.startswith("Received E1.31")]
    assert not warned, warned

    command("SetSetting,DisableFakeNetworkBridges,0")
    fppd.wait_for(lambda: {E131_PORT, DDP_PORT} <= set(udp_sockets()), timeout=10,
                  what="the fake listeners to open once the setting is 0")
