"""WLED audio sync sending from an audio input (WLEDAudioInput naming a
PipeWire node) rather than from the media fppd plays: the input here is the
`audio` fixture's null sink, captured from its monitor while fppd plays a
tone into it."""

import os
import socket
import statistics
import struct
import threading
import time

from audio import SINK, write_tone_wav

PORT = 21989


class Packets:
    """WLED audio-sync V2 packets arriving on PORT, as (sampleRaw,
    sampleSmth, fft) -- the layout test_wled_audio_sync's packet() builds."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", PORT))
        self.sock.settimeout(0.2)
        self.got = []
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                pkt = self.sock.recv(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(pkt) >= 44 and pkt[:5] == b"00002":
                raw, smth, _peak, _r, fft = struct.unpack_from("<ffBB16s", pkt, 8)
                self.got.append((time.monotonic(), raw, smth, bytes(fft)))

    def since(self, t):
        return [p for p in self.got if p[0] >= t]

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()


def test_input_capture_is_scaled_like_media(fppd, audio):
    """A tone at a quarter of full scale, captured from an audio input,
    goes out in the audio-sync packets at about a quarter of full volume
    (sampleRaw near 64 of 255), not pinned at the top.

    Regression: 888959191. The capture's S16 samples went to the analysis
    raw, 32768 times too large for the +/-1.0 it expects: volume and every
    FFT band sat at 255 whatever was playing, so reactive effects on the
    receivers sat flat."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 20, freq=1000, amplitude=0.25)
    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1",
                  WLEDAudioSyncPort=str(PORT), WLEDAudioInput=SINK)
    rx = Packets()
    try:
        fppd.start()
        fppd.command("Play Media", "Tone.wav", "1", "0", "1")
        time.sleep(3)
        since = time.monotonic()
        time.sleep(4)
        got = rx.since(since)
    finally:
        rx.close()
    assert len(got) > 50, f"{len(got)} audio-sync packets in 4 s"
    raw = statistics.median(p[1] for p in got)
    assert raw > 5, f"the capture heard nothing (median sampleRaw {raw}); this proves nothing"
    assert raw < 200, f"median sampleRaw {raw} of 255 for a tone at a quarter of full scale"
