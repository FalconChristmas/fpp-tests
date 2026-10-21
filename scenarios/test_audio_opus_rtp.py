"""Opus RTP audio streaming (OpusRTPManager), under MediaBackend "pipewire"
with an instances file, against the audio fixture's PipeWire."""

import os
import threading


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
