"""A Falcon V5 smart receiver on a real K8-Max cape's differential ports,
through the real PRUs: the listener hears the receiver's replies to the
queries the frames carry, and fppd's port monitor reports them.

Only a board with receivers attached can run it: the ports they are on
come in FPP_TESTS_V5_PORTS ("9-12", 1-based, one V5 receiver on each; the
workflow sets it for the board that has them) and it skips without. Run
with run-local.sh --host-pru --host-i2c --host-pinctrl and the device's own
fppd and fppoled stopped (scripts/device-scenarios.sh does, as a pass of its
own): the cape has to be the signed one, whose licence is what lets a smart
receiver port send anything, and its listener's pad has to be muxed.

What a receiver is seen to do is in /fppd/ports: with no frames going out
nothing queries it, and its port reads off with no current; while frames
flow its replies arrive (the protocol needs 20-30 frames to be sent before
they do) and the port reads on, with its current and an intact fuse.
"""

import os
import time

import pytest

from bbcape import pixel_output, strings_config
import pru
from pru import real_cape, real_pru  # noqa: F401 (fixtures)


@pytest.fixture
def real_receiver(real_cape):
    """real_cape (with the stub pinctrl the listener's pad is never muxed
    and the receivers are never heard), and the receivers' ports, from
    FPP_TESTS_V5_PORTS."""
    return receiver_ports()


def receiver_ports():
    """The 1-based ports a V5 receiver is on, from FPP_TESTS_V5_PORTS."""
    spec = os.environ.get("FPP_TESTS_V5_PORTS", "")
    if not spec:
        pytest.skip("no Falcon V5 receiver attached (FPP_TESTS_V5_PORTS)")
    first, _, last = spec.partition("-")
    return list(range(int(first), int(last or first) + 1))


def start_with_receivers(fppd, ports):
    """The K8-Max's 24 ports of 50 pixels (what an unsigned cape allows),
    one Falcon V5 receiver on each of `ports`."""
    outs = [pixel_output(n, 50, n * 150) for n in range(24)]
    for p in ports:
        outs[p - 1]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "K8-Max", outs))
    fppd.start(timeout=90)


def readings(fppd, ports):
    """{port: its receiver A's entry} from /fppd/ports."""
    want = {f"Port {p}": p for p in ports}
    return {want[e["name"]]: e.get("A", {}) for e in fppd.get("/fppd/ports") if e.get("name") in want}


def test_a_falcon_v5_receiver_answers_once_frames_flow(real_receiver, fppd):
    """Each receiver on the cape's ports reports on with its current while
    a test pattern runs, and no port reads a blown fuse for as long as it
    does.

    Regression: c36751c84. The first receiver of a chain was not counted
    (numReceivers and srCount started at 0), so a chain of one was never
    queried and no receiver ever reported. Red with that put back: the
    ports have no reading at all after 40 s.

    Not what this tells apart: 6ddef56ea (the setFuses packet; with the
    resetFuses packet back this still passes) and the phantom eFuse trips
    of d81c53cb5 (they came from the capture being overwritten while it was
    read, which needs a frame that only just fits its period; with one
    receiver at 50 pixels a port the frame fits easily).
    """
    ports = real_receiver
    start_with_receivers(fppd, ports)
    fppd.command("Test Start", "25", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        got = readings(fppd, ports)
        if len(got) == len(ports) and all(r.get("enabled") and r.get("ma", 0) > 0 for r in got.values()):
            break
        time.sleep(0.5)
    else:
        fppd.command("Test Stop")
        cape = [l for l in fppd.log().splitlines()
                if any(w in l.lower() for w in ("signature", "eeprom", "licens", "cape", "i2c"))]
        pytest.fail(f"the receivers did not report on with a current in 40 s: {readings(fppd, ports)}\n"
                    + "\n".join(cape[-25:]) + "\n" + fppd.tail())
    # steady state: the reports stay on and no fuse reads blown
    for _ in range(40):
        for p, r in readings(fppd, ports).items():
            assert r.get("status") is not False, f"port {p} reads a blown fuse: {r}"
            assert r.get("enabled"), f"port {p} dropped out: {r}"
        time.sleep(0.5)
    fppd.command("Test Stop")


def test_an_overloaded_receiver_chain_keeps_its_rest_frames(real_receiver, fppd):
    """Frames offered faster than a receiver chain's strings can clock out
    leave the share of frames that carry a query where the scheduler puts
    it, and do not turn every rest frame into another query.

    The scheduler follows a round of queries with a frame that carries none.
    PrepData asks it for the next packet on every offered frame, but only a
    frame SendData's back-pressure gate takes moves the packet cursor, so an
    answer of "none" that landed on a declined frame was asked for again and
    came back as a query.  Over budget nearly every frame carried one, each
    about 2.85 ms longer with a receiver answering, which pushed the output
    further over budget.  One V5 chain on a K8-Max, its head port at 300
    pixels and frames offered every 5 ms: 45% of frames carry a query under
    budget, 89% over budget before the fix, 45% after it, and the PRU's own
    ceiling for that config rose from 87 to 98 fps.

    Regression: 2c34cd2d8.  Red with that put back: about 89%.

    The listen windows are the listener PRU's own count (core 0 data RAM
    +8), and the frames the string PRU's (core 1, RING_FRAMES), so the share
    is what went out on the wire, not what fppd meant to send.
    """
    ports = real_receiver
    outs = [pixel_output(n, 50, n * 150) for n in range(24)]
    head = ports[0] - 1
    outs[head] = pixel_output(head, 300, 24 * 150)
    for p in ports:
        outs[p - 1]["differentialType"] = 10  # one Falcon V5 receiver
    fppd.settings(E131BridgingInterval="5")  # 200 fps offered, ~100 possible
    fppd.write("config/co-bbbStrings.json", strings_config("BBShiftString", "K8-Max", outs))
    fppd.start(timeout=90)
    fppd.command("Test Start", "25", "RGB Chase", "*", "FF0000-00FF00-0000FF")
    try:
        time.sleep(8)  # past the start-up config, number and fuse packets
        with pru.Pruss() as p:
            f0, c0, t0 = p.dram(1, pru.RING_FRAMES), p.dram(0, 8), time.monotonic()
            time.sleep(15)
            f1, c1, t1 = p.dram(1, pru.RING_FRAMES), p.dram(0, 8), time.monotonic()
    finally:
        fppd.command("Test Stop")
    frames, windows = (f1 - f0) & 0xFFFFFFFF, (c1 - c0) & 0xFFFFFFFF
    fps = frames / (t1 - t0)
    assert frames > 0, "the string PRU output no frames\n" + fppd.tail()
    # the control: the output really is over budget, or nothing was declined
    assert fps < 150, f"{fps:.1f} fps clocked out of 200 offered: not over budget, so this proves nothing"
    share = windows / frames
    assert share > 0.3, f"only {share:.0%} of {frames} frames opened a listen window: the chain is not being queried"
    assert share < 0.6, (f"{share:.0%} of {frames} frames carried a query over budget ({fps:.1f} fps); "
                         "the scheduler's rest frames are being turned into queries")
