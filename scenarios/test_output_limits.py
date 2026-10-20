"""Channel output configs that must be refused or cleaned before use: an
output whose channels run past the channel buffer, and an output interface
name that would reach a shell."""

import os
import time

from ddp import DdpReceiver
from serial import PtyReader
from show import ddp_output

CHANNELS = 150
MAX_CHANNELS = 8388608


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def generic_serial(device, start, count=100):
    return {"channelOutputs": [{
        "type": "GenericSerial", "enabled": 1, "startChannel": start, "channelCount": count,
        "device": device, "speed": 115200, "header": "HDR", "footer": "END"}]}


def test_a_serial_output_past_the_end_of_the_channel_buffer_is_refused(fppd):
    """A GenericSerial output whose 100 channels start 8 before the end of
    the channel buffer is disabled with a warning naming the limit; a DDP
    output next to it keeps sending. Moved inside the buffer and saved, it
    starts, and the warning comes down.

    Regression: 033fb4a25. The loader dropped the bad range from the set
    of channels to read but still added the output, which copied its 100
    channels from past the end of the sequence buffer every frame.
    """
    with PtyReader() as pty, DdpReceiver(CHANNELS) as rx:
        fppd.write("config/co-universes.json", ddp_output(CHANNELS))
        fppd.write("config/co-other.json", generic_serial(pty.device, MAX_CHANNELS - 7))
        fppd.settings(DisableFakeNetworkBridges="1")
        fppd.start()

        def refused():
            return [w for w in warnings(fppd)
                    if "GenericSerial" in w and str(MAX_CHANNELS) in w and "Output disabled" in w]
        fppd.wait_for(refused, timeout=10, what="the past-the-end warning")
        fppd.request("PUT", "/overlays/range/1-10", {"Value": 42})
        fppd.wait_for(lambda: rx.last() is not None and rx.last()[:10] == bytes([42] * 10),
                      timeout=10, what="the DDP output to keep sending")
        time.sleep(1)
        with pty.lock:
            sent = bytes(pty.data)
        assert b"HDR" not in sent, f"the refused output wrote {len(sent)} bytes"

        time.sleep(1.1)  # a save in a later second, as a person makes it
        fppd.write("config/co-other.json", generic_serial(pty.device, 1))
        fppd.wait_for(lambda: not refused(), timeout=15, interval=0.5,
                      what="the warning to come down after the fix")
        fppd.wait_for(lambda: b"HDR" + bytes([42] * 10) in bytes(pty.data), timeout=10,
                      what="the fixed output to send")


def test_an_output_interface_name_never_reaches_a_shell(fppd):
    """An E1.31 output whose "interface" carries a shell command is logged
    as invalid and ignored: the command never runs, and the output still
    sends on the interface fppd picks itself.

    Regression: d68502b56. The name went unchecked into the "tc qdisc show
    dev <name>" command line popen()ed to look for fq pacing, so
    "lo;touch <file>" ran touch at startup.
    """
    from udp import Listener
    pwned = os.path.join(fppd.media, "tmp", "pwned")
    cfg = {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 10,
        "interface": f"lo;touch {pwned}",
        "universes": [{"active": 1, "description": "e131", "id": 1, "startChannel": 1,
                       "channelCount": 10, "type": 1, "address": "127.0.0.1", "priority": 0,
                       "monitor": 0, "deDuplicate": 0}]}]}
    fppd.write("config/co-universes.json", cfg)
    # Pacing is what asks tc about the interface; it is on by default, but
    # don't depend on that.
    fppd.settings(DisableFakeNetworkBridges="1", UDPPacingRate="90")
    with Listener(5568) as rx:
        fppd.start()
        fppd.request("PUT", "/overlays/range/1-10", {"Value": 42})
        fppd.wait_for(lambda: len(rx.packets) > 0, timeout=10, what="E1.31 packets")
    assert not os.path.exists(pwned), "the interface name ran a shell command"
    assert "ignoring invalid interface" in fppd.log()
