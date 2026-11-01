"""Stop Media: stops the file Play Media started, by name."""

import os
import time

from audio import write_tone_wav
from test_media_commands import slot_status, sounding_seconds


def test_stop_media_stops_the_named_file_and_only_that_one(fppd, audio):
    """Stop Media with a file name silences what Play Media started for it,
    leaves a different file playing, and answers "Media Not Running" for a
    name that isn't playing.

    Regression: d97cb8c5e. There was no command to stop a Play Media
    started in the background short of Stop All Media."""
    for name, freq in (("A.wav", 500), ("B.wav", 900)):
        write_tone_wav(os.path.join(fppd.media, "music", name), 20, freq=freq)
    fppd.start()
    fppd.command("Play Media", "A.wav", "1", "0", "1", timeout=10)
    fppd.command("Play Media", "B.wav", "1", "0", "2", timeout=10)
    for slot in (1, 2):
        fppd.wait_for(lambda: (slot_status(fppd, slot) or {}).get("status") == "playing", timeout=5,
                      what=f"slot {slot} to play")
    assert fppd.command("Stop Media", "Nothing.wav", timeout=10) == "Media Not Running"
    assert fppd.command("Stop Media", "A.wav", timeout=10) == "Stopped"
    fppd.wait_for(lambda: (slot_status(fppd, 1) or {}).get("status") != "playing", timeout=5,
                  what="A.wav to stop")
    assert (slot_status(fppd, 2) or {}).get("status") == "playing", slot_status(fppd, 2)
    time.sleep(0.5)
    rec = audio.record()
    time.sleep(1.5)
    heard = sounding_seconds(rec.stop())
    assert heard > 1.0, f"B.wav should still sound, heard {heard:.2f} s"
    assert fppd.command("Stop Media", "B.wav", timeout=10) == "Stopped"
    time.sleep(0.8)
    rec = audio.record()
    time.sleep(1.5)
    heard = sounding_seconds(rec.stop())
    assert heard < 0.2, f"{heard:.2f} s still sounding after Stop Media for both files"
