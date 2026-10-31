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

    Also 564a6b9bb (before it a failed bind was exit(1): fppd ended at
    startup) and 7daafdc6d (type 9, ArtNet sent from a port of its own, which
    is what keeps going here).
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


def global_interface():
    """This machine's interface with a global IPv4 address (eth0 in a
    container), or None."""
    import subprocess
    out = subprocess.run(["ip", "-o", "-4", "addr", "show", "scope", "global"],
                         capture_output=True, text=True).stdout.split()
    return out[1] if len(out) > 1 else None


def test_artnet_sent_from_another_port_says_to_restart(fppd):
    """With 6454 held by another program and ArtNet output on an interface
    with its own address, output setup opens the ArtNet socket on another
    port, and the warning says FPPD must be restarted once the port is free:
    nothing tries 6454 again after that.

    Regression: faacde2f0. The warning said only that ArtNet input was off
    and output came from another port, so it read as something that would
    clear by itself, as the plain "ArtNet is off" warning does."""
    import pytest
    iface = global_interface()
    if not iface:
        pytest.skip("no interface with a global address: the fallback needs one")
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 100,
        "interface": iface, "universes": [
            {"active": 1, "description": "from 6454", "id": 1, "startChannel": 1,
             "channelCount": 100, "type": 3, "address": "127.0.0.1", "priority": 0,
             "monitor": 0, "deDuplicate": 0}]}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    held = Listener(ARTNET_PORT, host="0.0.0.0")
    try:
        fppd.start()
        fppd.wait_for(lambda: artnet_warnings(fppd), timeout=15, interval=0.5,
                      what="the ArtNet port warning")
        warnings = artnet_warnings(fppd)
        # The control: this is the fallback, not "ArtNet is off".
        assert "sent from another port" in warnings[0], warnings
        assert "Restart FPPD" in warnings[0], warnings
    finally:
        held.close()


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
    again.

    Feature: 732ac0b61 (before it, ci-universes.json was read only at
    startup: the save was not taken until fppd restarted)."""
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


def artnet_loop_outputs(description):
    """co-universes.json: ArtNet universe 5 sent from 6454 (type 3) to
    127.0.0.2 -- not one of fppd's own addresses, so not refused as
    "myself", but on loopback, so it comes back to fppd's ArtNet socket."""
    return {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 100,
        "interface": "lo", "universes": [
            {"active": 1, "description": description, "id": 5, "startChannel": 1,
             "channelCount": 100, "type": 3, "address": "127.0.0.2", "priority": 0,
             "monitor": 0, "deDuplicate": 0}]}]}


def artnet_input_packets(fppd):
    for u in fppd.get("/fppd/e131stats")["universes"]:
        if str(u["id"]) == "5":
            return int(u["packetsReceived"])
    return 0


def artnet_input_counting(fppd, what):
    """ArtNet input universe 5 is still counting packets: more of them two
    seconds on."""
    def grows():
        before = artnet_input_packets(fppd)
        time.sleep(2)
        return artnet_input_packets(fppd) > before + 10
    fppd.wait_for(grows, timeout=12, interval=0.1, what=what)


def test_artnet_input_and_output_keep_their_shared_socket_across_reloads(fppd):
    """ArtNet output and ArtNet input share the one socket on 6454; saving
    the outputs, and then the inputs, leaves both working. fppd's own
    ArtNet output comes back to its ArtNet input here, so the input's
    packet count growing shows both ends at once.

    Regression: 39bd42410. Both reloads closed the shared socket: the
    outputs' reload closed it under the input, which then heard nothing
    more, and the inputs' reload closed it under the output."""
    frames = unique_frames(1200, 100)  # 60 s
    write_fseq(os.path.join(fppd.media, "sequences", "Show.fseq"), frames, step_ms=50)
    fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")]))
    fppd.write("config/co-universes.json", artnet_loop_outputs("loop"))
    fppd.write("config/ci-universes.json", artnet_input(True))
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_E131Bridge="info")
    fppd.start()
    fppd.command("Start Playlist", "Show", "false", "false")
    # The control: the output's packets reach the input at all.
    artnet_input_counting(fppd, "the ArtNet output to reach the ArtNet input")

    time.sleep(1.1)  # a save in a later second, as a person makes it
    fppd.write("config/co-universes.json", artnet_loop_outputs("loop, saved again"))
    time.sleep(2)
    artnet_input_counting(fppd, "ArtNet in and out to keep going after the outputs were saved")

    reloads = fppd.log().count("Universe Count = ")
    fppd.write("config/ci-universes.json", artnet_input(True))
    fppd.wait_for(lambda: fppd.log().count("Universe Count = ") > reloads, timeout=10,
                  what="the inputs to reload")
    artnet_input_counting(fppd, "ArtNet in and out to keep going after the inputs were saved")
