"""Opus RTP audio streaming (OpusRTPManager), under MediaBackend "pipewire"
with an instances file, against the audio fixture's PipeWire."""

import os
import shutil
import socket
import threading
import time

import pytest

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


CONFIG = "config/pipewire-opus-rtp-instances.json"
SEND_FAILED = "Opus RTP: audio send stream failed to start"
RECV_FAILED = "Opus RTP: audio receive stream failed to start"


def opus_warnings(fppd):
    """The Opus RTP warnings in fppd's warnings API."""
    return {w for w in fppd.get("/fppd/warnings") if w.startswith("Opus RTP:")}


def opus_apply(fppd):
    """"Opus RTP Apply", and wait for it to have built its streams."""
    n = fppd.log().count("OpusRTPManager: Applied config")
    fppd.command("Opus RTP Apply", timeout=60)
    fppd.wait_for(lambda: fppd.log().count("OpusRTPManager: Applied config") > n, timeout=30,
                  what="the apply to finish")


def failing_tx_and_rx(fppd):
    """A send instance "tx" and a receive instance "rx" that both fail to
    start, as at boot, because no PipeWire is running; fppd started, and
    both warnings up. Returns the receive port."""
    if not shutil.which("pipewire") or not shutil.which("wireplumber"):
        pytest.skip("PipeWire and WirePlumber are not installed")
    advanced_backend(fppd)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("0.0.0.0", 0))
        rx_port = s.getsockname()[1]
    fppd.write(CONFIG, {"requireGroupSource": False, "instances": [
        {"id": 1, "name": "tx", "mode": "send", "enabled": True, "destIP": "127.0.0.1",
         "port": 15010, "channels": 2},
        {"id": 2, "name": "rx", "mode": "receive", "enabled": True, "destIP": "127.0.0.1",
         "port": rx_port, "channels": 2}]})
    fppd.start()
    fppd.wait_for(lambda: opus_warnings(fppd) >= {SEND_FAILED, RECV_FAILED}, timeout=30,
                  what=f"both failed-to-start warnings (precondition; have {sorted(opus_warnings(fppd))})")
    return rx_port


def running_modes(fppd):
    """The modes of the streams /opusrtp/status lists as running, asked
    again while it answers "status unavailable" (a watchdog pass holds the
    pipeline lock)."""
    def modes():
        pipelines = fppd.get("/opusrtp/status")["pipelines"]
        if any(p["mode"] == "unknown" for p in pipelines):
            return None
        return (sorted(p["mode"] for p in pipelines if p["running"]),)
    return fppd.wait_for(modes, timeout=10, interval=0.1, what="the Opus RTP status")[0]


class Feeder:
    """Keeps a node fed from the test sink's monitor, linking it each time
    it appears, as an Audio Output Group targeting it does on a device. A
    sender nothing feeds blocks its apply for 30 s and then fails."""

    def __init__(self, node):
        from test_rtsp_outputs import link_monitor_to
        self.stop = threading.Event()

        def spin():
            while not self.stop.wait(0.01):
                link_monitor_to(node)
        self.thread = threading.Thread(target=spin, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join()


def test_opus_stream_failed_warnings_come_down_when_the_streams_start(fppd):
    """An Opus RTP send and receive stream fail to start (no PipeWire yet),
    and the warnings API shows both "failed to start" warnings. With
    PipeWire up and the receive port held by another socket, an apply
    starts the send stream but not the receive one: the send warning comes
    down and the receive one stays. With the port free again, the next
    apply starts both and no Opus RTP warning is left.

    Regression: ccee8eb3a. Nothing removed these warnings, so they stayed
    up until fppd restarted, through applies that started every stream."""
    from audio import AudioServer
    rx_port = failing_tx_and_rx(fppd)
    blocker = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    blocker.bind(("0.0.0.0", rx_port))  # no SO_REUSEADDR, so udpsrc's bind fails
    server = feeder = None
    try:
        server = AudioServer()
        feeder = Feeder("opusrtp_tx_send")
        opus_apply(fppd)
        assert running_modes(fppd) == ["send"], "expected only the send stream to start"
        assert opus_warnings(fppd) == {RECV_FAILED}, \
            f"after an apply that started the send stream: {sorted(opus_warnings(fppd))}"

        blocker.close()
        opus_apply(fppd)
        assert running_modes(fppd) == ["receive", "send"], "expected both streams to start"
        assert opus_warnings(fppd) == set(), \
            f"after an apply that started both streams: {sorted(opus_warnings(fppd))}"
    finally:
        blocker.close()
        if feeder:
            feeder.close()
        if server:
            server.close()


def test_opus_stream_failed_warnings_come_down_at_cleanup(fppd):
    """Both Opus RTP streams fail to start (no PipeWire) and both warnings
    are up; with the instances file gone, "Opus RTP Cleanup" (what the
    Opus RTP page's Apply sends when there is no instances file) stops
    everything and takes both warnings down.

    Regression: ccee8eb3a. Cleanup() left the warnings up, so the banner
    still said a stream had failed with nothing configured to run."""
    failing_tx_and_rx(fppd)
    os.unlink(os.path.join(fppd.media, CONFIG))
    fppd.command("Opus RTP Cleanup", timeout=60)
    assert opus_warnings(fppd) == set(), f"after the cleanup: {sorted(opus_warnings(fppd))}"
