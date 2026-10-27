"""What a media output's streaming threads may still do once it is told to
stop: its appsink callbacks must be off before the pipeline is taken down,
whichever way the stop came in."""

import os
import time

from test_audio_backends import write_tones_wav
from udp import Listener
from test_video import free_udp_port


def test_a_stopped_track_gets_no_sample_callbacks_after_it_is_freed(fppd, audio):
    """WLED audio sync sending, so the WLED sample tap of every playing
    track is open, and a four-channel file (a pipewiresink of its own, so
    the teardown first plays 250 ms of silence with the pipeline still
    PLAYING) played and stopped with Stop Media Slot ten times: fppd stays
    up with no sanitizer report, and the tap was being fed (precondition:
    the sender saw sound).

    Regression: 4fc5793f8. Stop() took the pipeline down without first
    setting the shutdown flag and disconnecting the appsinks' new-sample
    handlers; only Close() did that, and a playlist or a stop command
    calls Stop() first, after which Close() finds no pipeline and skips
    it. The handlers, holding the output's raw pointer, kept firing on the
    streaming thread while the pipeline was torn down -- and today the
    audio-only teardown runs on a thread of its own after the output is
    freed, so each sample read the freed output (an ASan
    heap-use-after-free in OnNewSample). The commit's deadlock against the
    malloc arena lock isn't reproduced here."""
    import struct
    port = free_udp_port()
    write_tones_wav(os.path.join(fppd.media, "music", "Quad.wav"), 6, [300, 500, 700, 900])
    fppd.settings(WLEDAudioSyncMode="send", WLEDAudioSyncDest="127.0.0.1", WLEDAudioSyncPort=str(port))
    with Listener(port) as rx:
        fppd.start()
        for _ in range(10):
            fppd.command("Play Media", "Quad.wav", "1", "0", "1")
            time.sleep(1.5)
            fppd.command("Stop Media Slot", "1", timeout=10)
            time.sleep(0.6)
        with rx.lock:
            peaks = [struct.unpack_from("<f", d, 40)[0] for _, d in rx.packets if len(d) == 44]
    assert any(p > 100 for p in peaks), \
        f"the sender never saw the file's sound (precondition: the sample tap ran); {len(peaks)} packets"
    fppd.check_alive()
