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


def art_trigger(key, subkey):
    """An ArtTrigger packet (OpTrigger 0x9900): OemCode 0xFFFF, Key, SubKey
    and an empty 512-byte payload."""
    import struct
    return (b"Art-Net\0" + struct.pack("<H", 0x9900) + struct.pack(">H", 14) + bytes(2)
            + struct.pack(">H", 0xFFFF) + bytes([key, subkey]) + bytes(512))


def artnet_input(enabled):
    """ci-universes.json: one E1.31 input universe, and ArtNet universe 5
    as well when `enabled`."""
    rows = [{"active": 1, "id": 10, "startChannel": 1, "channelCount": 100, "type": 1,
             "priority": 0, "address": ""}]
    if enabled:
        rows.append({"active": 1, "id": 5, "startChannel": 101, "channelCount": 100, "type": 3,
                     "priority": 0, "address": ""})
    return {"channelInputs": [{"type": "universes", "enabled": 1, "startChannel": 1,
                               "channelCount": 512, "universes": rows}]}


def plugin_heard(fppd, key, timeout=5):
    """Send ArtTriggers with `key` until the plugin logs one, or time out."""
    from packets import send
    line = f"artnet plugin fpp-artnet trigger key {key} subkey 7"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        send([art_trigger(key, 7)], ARTNET_PORT)
        if line in fppd.log():
            return True
        time.sleep(0.25)
    return False


def test_a_plugin_hears_artnet_on_a_player_with_no_artnet_input(fppd):
    """A native plugin that adds an ArtTrigger handler on a player whose
    own inputs have no ArtNet universe is handed the ArtTriggers sent to
    the player.

    Regression: 6df3c4502. Adding an opcode handler only put it in the
    table: the socket was opened and put in the epoll set by the bridge,
    for its own ArtNet input, or by a caller that registered the descriptor
    itself. With neither, the ArtTrigger was never read."""
    import native_plugin
    native_plugin.install(fppd, "fpp-artnet", source="artnetplugin.cpp")
    fppd.write("config/ci-universes.json", artnet_input(False))
    fppd.start()
    fppd.wait_for(lambda: "artnet plugin fpp-artnet loaded" in fppd.log(), timeout=20,
                  what="the plugin to load")
    assert plugin_heard(fppd, 1), "the plugin was never handed an ArtTrigger"


def test_a_plugin_keeps_hearing_artnet_when_the_bridge_drops_its_own(fppd):
    """A native plugin with an ArtTrigger handler on a player with an ArtNet
    input universe still gets ArtTriggers after the inputs are saved
    without ArtNet.

    Regression: 6df3c4502. The bridge's reload took the shared ArtNet
    socket out of the epoll set and put it back only for an ArtNet input
    of its own, so the plugin went deaf until something registered it
    again."""
    import native_plugin
    native_plugin.install(fppd, "fpp-artnet", source="artnetplugin.cpp")
    fppd.write("config/ci-universes.json", artnet_input(True))
    fppd.settings(LogLevel_E131Bridge="info")
    fppd.start()
    fppd.wait_for(lambda: "artnet plugin fpp-artnet loaded" in fppd.log(), timeout=20,
                  what="the plugin to load")
    assert plugin_heard(fppd, 1), "precondition: the plugin never heard an ArtTrigger"
    assert "Universe Count = 1" not in fppd.log()
    fppd.write("config/ci-universes.json", artnet_input(False))
    fppd.wait_for(lambda: "Universe Count = 1" in fppd.log(), timeout=10,
                  what="the inputs to reload without ArtNet")
    assert plugin_heard(fppd, 2), "after the reload, the plugin was never handed an ArtTrigger"
