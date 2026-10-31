"""What a native plugin does with MultiSync: sends its own data to the
remotes (SendPluginData) and registers MultiSyncPlugin hooks from a thread of
its own, as fppd plays. multisyncplugin.cpp is the plugin."""

import os
import subprocess
import time

from capture import UdpCapture
from fseq import _sanitizer_flags, unique_frames
from multisync import PORT
from show import CHANNELS, install
from test_plugin_scripts import plugin

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = "127.0.0.2"
NAME = "fpp-mstest"


def install_plugin(fppd):
    """Build multisyncplugin.cpp into plugins/<NAME> as a C++ plugin, the way
    native_plugin.install() builds nativeplugin.cpp."""
    d = plugin(fppd, name=NAME, types="c++")
    src = os.path.join(os.environ["FPP_TREE"], "src")
    cmd = ["c++", "-std=gnu++20", "-O1", "-g", "-fPIC", "-shared",
           *_sanitizer_flags(os.path.join(src, "libfpp.so")),
           f'-DPLUGIN_NAME="{NAME}"', f"-I{src}", "-I/usr/include/jsoncpp",
           os.path.join(HERE, "multisyncplugin.cpp"),
           f"-L{src}", "-lfpp", f"-Wl,-rpath,{src}", "-o", os.path.join(d, f"lib{NAME}.so")]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("building the MultiSync plugin failed:\n" + r.stderr[-4000:])
    return d


def plugin_packets(cap):
    """The plugin data packets (0x05) fppd sent: their extra data."""
    return [p[7:] for _, _, _, p in cap.snapshot() if p[:4] == b"FPPD" and p[4] == 0x05]


def test_plugin_data_too_big_for_a_packet_is_refused(fppd):
    """A plugin's data goes out to the remotes in a plugin packet; data
    bigger than a packet holds is refused, and fppd carries on.

    Regression: 2e6b2516c. SendPluginData memcpy'd whatever length the
    plugin gave it into a 2048-byte buffer on the stack: 4000 bytes
    overflowed it (ASan: stack-buffer-overflow).
    """
    install_plugin(fppd)
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("MultiSync Test Plugin Data", "100")
        fppd.wait_for(lambda: plugin_packets(cap), timeout=5, what="the plugin's data to be sent")
        try:
            fppd.command("MultiSync Test Plugin Data", "4000")
        except ConnectionError:
            pass  # fppd went down answering: check_alive() says how
        time.sleep(1)
        fppd.check_alive()
        sent = plugin_packets(cap)
    assert [len(p) for p in sent] == [len(NAME) + 1 + 100], \
        f"plugin packets of {[len(p) for p in sent]} bytes"
    assert sent[0] == NAME.encode() + b"\0" + b"P" * 100, sent[0][:40]
    assert fppd.get("/fppd/status").get("fppd") == "running"


def test_a_plugin_registering_hooks_while_the_show_plays(fppd):
    """A plugin that adds and removes MultiSync hooks from a thread of its
    own while a master plays and sends sync packets to its remotes leaves
    fppd running (and, under TSan, with no data race on the hook list).

    Regression: 2e6b2516c (run with --flavor tsan). The hook list was
    walked by the output thread for every sync packet while add/
    removeMultiSyncPlugin() changed it from the plugin's thread with no
    lock: a reallocation under the walk is a use-after-free.
    """
    install_plugin(fppd)
    install(fppd, unique_frames(400, CHANNELS), step_ms=25)
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE)
    with UdpCapture(PORT, REMOTE) as cap:
        fppd.start()
        fppd.command("Start Playlist", "Show", "true", "false")
        time.sleep(1)
        fppd.command("MultiSync Test Plugin Churn", "3000")
        fppd.wait_for(lambda: str(fppd.command("MultiSync Test Plugin Churned")).startswith("done"),
                      timeout=60, interval=0.5, what="the plugin's thread to finish")
        handed = int(str(fppd.command("MultiSync Test Plugin Churned")).split()[1])
        fppd.command("Stop Now")
        time.sleep(0.5)
        syncs = [p for _, _, _, p in cap.snapshot() if p[:4] == b"FPPD" and p[4] == 0x01]
    fppd.check_alive()
    # The output thread walked the hooks while the plugin's thread changed them.
    assert handed > 0, "the hooks the plugin added never saw a sync packet"
    assert len(syncs) > 5, f"only {len(syncs)} sync packets sent while the plugin ran"


def test_a_plugin_hears_the_control_packets_a_remote_receives(fppd):
    """A plugin's MultiSync hooks are handed every kind of control packet a
    remote receives: sequence and media open/start/stop/sync, blanking,
    plugin data and FPP commands.

    Feature: 1b96eb87c. The Received* hooks were only called for sequence
    packets on a master's own sends; a plugin in remote mode heard nothing.
    """
    import socket
    from multisync import control_packet, fpp_command_packet, sync_packet
    install_plugin(fppd)
    log = os.path.join(fppd.media, "tmp", "ms-recv.log")
    fppd.settings(DisableFakeNetworkBridges="1", fppMode="remote")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send(pkt):
        sock.sendto(pkt, ("127.0.0.1", PORT))
        time.sleep(0.15)

    fppd.start(extra_env={"MS_RECV_LOG": log})
    for kind in ("fseq", "media"):
        for action in ("open", "start", "sync", "stop"):
            send(sync_packet(action, kind, 7, 0.5, "Show.fseq" if kind == "fseq" else "Song.mp3"))
    send(control_packet(0x03, b""))
    send(control_packet(0x05, b"other-plugin\0" + b"DATA"))
    send(fpp_command_packet("All Lights Off", []))

    def lines():
        try:
            with open(log) as f:
                return [l.rstrip("\n") for l in f]
        except FileNotFoundError:
            return []
    want = ["seqopen Show.fseq", "seqstart Show.fseq", "seqsync Show.fseq 7", "seqstop Show.fseq",
            "mediaopen Song.mp3", "mediastart Song.mp3", "mediasync Song.mp3", "mediastop Song.mp3",
            "blanking", "plugindata other-plugin 4 D", "command All Lights Off"]
    fppd.wait_for(lambda: all(w in lines() for w in want), timeout=10, interval=0.3,
                  what="the plugin to hear every packet; heard " + str(lines()))
