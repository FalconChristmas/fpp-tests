"""ArtNet output when another program already holds UDP port 6454."""

import os
import time

from fseq import unique_frames, write_fseq
from packets import ARTNET_PORT, parse_artdmx
from show import playlist, sequence_entry
from udp import Listener


def artnet_warnings(fppd):
    return [w for w in fppd.get("/fppd/status").get("warnings", []) if "ArtNet" in w and "6454" in w]


def test_taken_artnet_port_warns_once_and_keeps_the_log_quiet(fppd):
    """With 6454 held by another program, ArtNet output that must send from
    6454 (type 3) is off with one warning in the UI, while ArtNet sent from
    its own port (type 9) carries on. The log does not grow with every
    frame, and the warning clears once the port is free again.

    Regression: ff9d45cff.
    Every frame asked for the ArtNet socket again, and each failed bind
    logged an error: 20-40 lines a second for as long as the port stayed
    taken -- on an SD card, all show long. The warning it raised said only
    "Socket bind failed for ArtNet" and never cleared.
    """
    frames = unique_frames(1200, 200)  # 60 s
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 200,
        "interface": "lo", "universes": [
            {"active": 1, "description": "from 6454", "id": 1, "startChannel": 1,
             "channelCount": 100, "type": 3, "address": "127.0.0.1", "priority": 0,
             "monitor": 0, "deDuplicate": 0},
            {"active": 1, "description": "own port", "id": 2, "startChannel": 101,
             "channelCount": 100, "type": 9, "address": "127.0.0.1", "priority": 0,
             "monitor": 0, "deDuplicate": 0},
        ]}]})
    fppd.settings(DisableFakeNetworkBridges="1")

    # "another program", on every address: fppd binds its output interface's
    # address, which is not loopback in a container
    held = Listener(ARTNET_PORT, host="0.0.0.0")
    try:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      what="the show to play")
        time.sleep(1)
        log_at_start = len(fppd.log())
        time.sleep(5)
        grew = len(fppd.log()) - log_at_start
        assert grew < 2000, f"fppd.log grew {grew} bytes in 5 s with the ArtNet port taken"
        warnings = artnet_warnings(fppd)
        assert len(warnings) == 1, \
            f"want one warning naming the ArtNet port: {fppd.get('/fppd/status').get('warnings')}"

        with held.lock:
            got = [parse_artdmx(p) for _, p in held.packets]
        universes = {d["universe"] for d in got if d}
        assert 2 in universes, "ArtNet from its own port (type 9) stopped too"
        # With an interface up, output setup may open the ArtNet socket on
        # another port (as in a container); with loopback alone it can't
        # (run-local.sh), and that output is off. Either way the warning
        # must say which, and the output must do what it says.
        fallback = "sent from another port" in warnings[0]
        if fallback:
            assert 1 in universes, f"the warning says ArtNet is sent from another port, but it isn't: {warnings[0]}"
        else:
            assert "ArtNet is off" in warnings[0], warnings[0]
            assert 1 not in universes, f"the warning says ArtNet is off, but it was sent: {warnings[0]}"
    finally:
        held.close()

    if fallback:
        # By decision, a socket open on another port is kept: nothing tries
        # 6454 again, so the warning stays up -- and tells the user to
        # restart FPPD once the port is free (faacde2f0).
        assert "Restart FPPD" in warnings[0], warnings[0]
        return
    # The port is free: within the retry interval fppd takes it and the
    # warning comes down.
    fppd.wait_for(lambda: not artnet_warnings(fppd), timeout=20, interval=0.5,
                  what="the ArtNet port warning to clear once the port was free")


def test_taken_artnet_port_leaks_no_sockets(fppd):
    """While another program holds 6454, fppd's open file descriptors stay
    put.

    Regression: a4184c927. A failed bind returned without closing the socket
    it had just made, and the output asked for the socket every frame: one
    leaked fd per frame until fppd ran out.
    """
    import os
    frames = unique_frames(1200, 100)
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 100,
        "interface": "lo", "universes": [{"active": 1, "description": "from 6454", "id": 1, "startChannel": 1,
                       "channelCount": 100, "type": 3, "address": "127.0.0.1", "priority": 0,
                       "monitor": 0, "deDuplicate": 0}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    held = Listener(ARTNET_PORT, host="0.0.0.0")
    try:
        fppd.start()
        fppd.command("Start Playlist", "Show", "false", "false")
        time.sleep(2)
        fds = lambda: len(os.listdir(f"/proc/{fppd.proc.pid}/fd"))
        before = fds()
        time.sleep(5)
        grew = fds() - before
        assert grew < 5, f"fppd opened {grew} more file descriptors in 5 s with the ArtNet port taken"
    finally:
        held.close()
