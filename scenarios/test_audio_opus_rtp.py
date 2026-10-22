"""Opus RTP audio streaming (OpusRTPManager), under MediaBackend "pipewire"
with an instances file, against the audio fixture's PipeWire."""

import os
import socket
import threading
import time

from audio import write_tone_wav


def advanced_backend(fppd):
    """MediaBackend "pipewire" in place of the audio fixture's simple one."""
    path = os.path.join(fppd.media, "settings")
    with open(path) as f:
        lines = [l for l in f if not l.startswith("MediaBackend ")]
    lines.append('MediaBackend = "pipewire"\n')
    with open(path, "w") as f:
        f.writelines(lines)


def test_opus_rtp_applies_at_once_from_two_clients(fppd, audio):
    """Two "Opus RTP Apply" commands at the same moment, round after
    round: each tears the streams down and builds them again, and fppd
    survives every round.

    Regression: 8cea6251d. ApplyConfig() joined the watchdog thread at the
    top and started a new one at the end, unserialized: two overlapping
    applies both got past the join, and the second assignment to a
    still-joinable std::thread called std::terminate()."""
    advanced_backend(fppd)
    fppd.write("config/pipewire-opus-rtp-instances.json", {"requireGroupSource": False, "instances": [
        {"id": 1, "name": "rx", "mode": "receive", "enabled": True, "destIP": "127.0.0.1",
         "port": 15004, "channels": 2}]})
    fppd.start()
    fppd.wait_for(lambda: "Opus RTP receive pipeline [1]" in fppd.log() or "OpusRTPManager: Applied config" in fppd.log(),
                  timeout=30, what="the Opus RTP config to be applied at startup")
    errors = []
    for rnd in range(15):
        barrier = threading.Barrier(2)

        def apply():
            barrier.wait()
            try:
                fppd.command("Opus RTP Apply", timeout=30)
            except Exception as e:  # an HTTP error is an answer; a wedge or death is not
                if "wedged" in str(e) or "Connection" in str(e):
                    errors.append(repr(e)[:200])
        threads = [threading.Thread(target=apply) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        fppd.check_alive()
        assert not errors, f"round {rnd}: {errors}"


def test_an_opus_sender_linked_as_it_appears_keeps_sending(fppd, audio):
    """An Opus RTP send instance whose node is fed (from the test sink's
    monitor, with a tone playing) the moment the node appears, as an audio
    group targeting it does: RTP keeps arriving at its destination, a
    packet every 20 ms.

    Regression: 5a98f1b0b. The send pipeline ran on pipewiresrc's
    GstPipeWireClock, which stops advancing for a follower stream once the
    graph's real driver takes it over: the sender passed its first packets
    and then waited on that clock for good.

    Feature: 9a88f2bbd (Opus RTP streaming)."""
    from test_rtsp_outputs import link_as_it_appears
    advanced_backend(fppd)
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", 0))
    rx.settimeout(0.2)
    port = rx.getsockname()[1]
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 30, amplitude=0.5)
    fppd.write("config/pipewire-opus-rtp-instances.json", {"requireGroupSource": False, "instances": [
        {"id": 1, "name": "tx", "mode": "send", "enabled": True, "destIP": "127.0.0.1",
         "port": port, "channels": 2}]})
    linked = link_as_it_appears("opusrtp_tx_send")
    try:
        fppd.start(timeout=90)
        fppd.wait_for(lambda: linked, timeout=30, what="the sender's node to be linked")
        fppd.command("Play Media", "Tone.wav", "1", "0", "1")
        time.sleep(2)
        packets, end = 0, time.monotonic() + 3
        while time.monotonic() < end:
            try:
                rx.recv(65536)
                packets += 1
            except socket.timeout:
                pass
    finally:
        rx.close()
    assert packets >= 100, f"{packets} RTP packets in 3 s (one per 20 ms is 150)"
