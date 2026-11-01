"""One media file started by Play Media on several slots at once, heard on
a PipeWire null sink."""

import os
import time

from audio import write_tone_wav
from test_media_commands import slot_status, sounding_seconds


def test_one_file_on_three_slots_is_stopped_by_stop_all_media(fppd, audio):
    """The same file started on slots 1, 2 and 3 in quick succession plays
    on all three, and one Stop All Media silences every one of them.

    Regression: 0e4ea0918. Command media was tracked by file name alone, so
    each start of the same file replaced the one before it in the list of
    running media: Stop All Media (and the deferred cleanup) no longer knew
    the earlier ones, which kept playing where no command could reach them
    (and the cleanup of one could drop or free another's entry).

    Also guards dca097622, which registered Stop Media and Stop All Media
    again (they had been commented out: "No command found").

    Also 253dfc5b4: the Stop All Media command itself, which silences the
    media Play Media started."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 20)
    fppd.start()
    for slot in (1, 2, 3):
        fppd.command("Play Media", "Tone.wav", "1", "0", str(slot), timeout=10)
    for slot in (1, 2, 3):
        fppd.wait_for(lambda: (slot_status(fppd, slot) or {}).get("status") == "playing", timeout=5,
                      what=f"slot {slot} to play")
    fppd.command("Stop All Media", timeout=10)
    time.sleep(0.8)
    rec = audio.record()
    time.sleep(1.5)
    heard = sounding_seconds(rec.stop())
    playing = [s for s in (1, 2, 3) if (slot_status(fppd, s) or {}).get("status") == "playing"]
    assert heard < 0.2 and not playing, \
        f"{heard:.2f} s still sounding, slots {playing} still playing after Stop All Media"
    fppd.check_alive()
