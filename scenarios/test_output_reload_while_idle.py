"""An output reload while the channel output thread waits idle.

After a test or sequence stops, the output thread waits up to 2.5 s to be
asked for again before it exits. Saving the outputs reloads them on fppd's
main loop, which first has to hold the output thread off. The main loop also
answers the command socket, which the web UI's PHP reads with a 1 s timeout.
"""

import os
import socket
import tempfile
import time

from show import CHANNELS, ddp_output

SERVER = "/run/fppd/FPPD"
FILL = {"mode": "RGBFill", "cycleMS": 1000, "color1": 10, "color2": 20, "color3": 30,
        "enabled": 1, "channelSet": "1-150", "channelSetType": "channelRange"}


def get_test_mode_seconds(timeout=5):
    """Ask fppd for its test mode over the command socket, as the UI does;
    return how long the answer took."""
    path = tempfile.mktemp(prefix="fpp-test-client-", dir="/run/fppd")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        s.bind(path)
        s.settimeout(timeout)
        t0 = time.monotonic()
        s.sendto(b"GetTestMode", SERVER)
        s.recv(4096)
        return time.monotonic() - t0
    finally:
        s.close()
        os.unlink(path)


def test_outputs_saved_just_after_a_test_stop_leave_the_command_socket_answering(fppd):
    """Outputs saved 0.2 s after a Test Stop are reloaded, and through the
    next 3 s the command socket answers within 0.5 s every time; the run
    repeats five times.

    Regression: 52249174f. The output thread held outputThreadLock
    through its 2.5 s idle wait, and the reload on the main loop waited for
    that lock: the main loop stopped for the rest of the wait, GetTestMode
    went unanswered past the UI's 1 s timeout, and the Display Testing page
    read test mode as null and threw."""
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_ChannelOut="info")
    fppd.start()
    worst = []
    for n in range(5):
        fppd.post("/fppd/testing", FILL)
        time.sleep(1.0)
        fppd.post("/fppd/testing", {"enabled": 0})
        time.sleep(0.2)
        before = fppd.log().count("Determined range needed")
        # A different channel count each round, so the file really changes.
        fppd.write("config/co-universes.json", ddp_output(CHANNELS - 1 - n))
        slowest = 0.0
        end = time.monotonic() + 3.0
        while time.monotonic() < end:
            slowest = max(slowest, get_test_mode_seconds())
            time.sleep(0.05)
        assert fppd.log().count("Determined range needed") > before, \
            f"round {n + 1}: the saved outputs were never reloaded"
        worst.append(slowest)
    print("slowest answer per round: " + ", ".join(f"{w:.2f} s" for w in worst))
    assert max(worst) < 0.5, \
        f"the command socket stalled after an output reload: slowest answers {worst}"
