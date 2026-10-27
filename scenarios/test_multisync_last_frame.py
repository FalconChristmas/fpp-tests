"""MultiSync's record of the frame it last sent a sync packet for, written by
the channel output thread with every frame and reset by each sequence open,
start and stop -- sent from whichever thread moves the sequence. Run under
TSan (run.sh --flavor tsan), where an unsynchronized pair shows as a report
whether or not the two accesses happen to overlap; under ASan these pass.
The other thread here is a plugin's (syncresetplugin.cpp, built by
plugin_build.py), so nothing but MultiSync's own synchronization orders it
against the output thread."""

import time

import plugin_build
from fseq import unique_frames
from show import CHANNELS, install

REMOTE = "127.0.0.2"


def test_a_stop_packet_sent_from_another_thread_while_a_sequence_syncs(fppd):
    """As master, a sequence plays (the output thread sending its sync
    packets) while a plugin thread sends sequence stop packets for another
    file over and over: the sequence plays on, and both keep sending.

    Regression: d8d8745fb. m_lastFrame and m_lastFrameSent were plain ints:
    SendSeqSyncPacket() read and wrote them on the output thread every
    frame, and the open, start and stop packets reset them from the thread
    that moved the sequence, with nothing ordering the two (TSan: a data
    race on every sequence stop during playback). Every access is a relaxed
    atomic one now."""
    install(fppd, unique_frames(400, CHANNELS), step_ms=50)
    plugin_build.build_and_install(fppd, "syncresetplugin.cpp", "fpp-syncreset")
    fppd.settings(MultiSyncEnabled="1", MultiSyncRemotes=REMOTE, DisableFakeNetworkBridges="1")
    fppd.start()
    fppd.wait_for(lambda: "fpp-syncreset Sends" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the plugin to load")
    fppd.command("Start Playlist", "Show", "false", "false")
    fppd.wait_for(lambda: fppd.get("/fppd/status", timeout=5).get("status_name") == "playing",
                  timeout=10, interval=0.2, what="the sequence to play")
    before = int(str(fppd.command("fpp-syncreset Sends")))
    time.sleep(4)
    assert fppd.get("/fppd/status", timeout=5).get("status_name") == "playing"
    assert int(str(fppd.command("fpp-syncreset Sends"))) > before + 20, "the plugin thread stopped sending"
    fppd.command("Stop Now")
