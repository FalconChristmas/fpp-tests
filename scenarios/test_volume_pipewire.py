"""The master volume on the PipeWire backend, read back from PipeWire
itself: what pactl says the card sinks' volume and mute are after
/fppd/volume, on the audio fixture's PipeWire."""

import os
import re
import subprocess
import time

from audio import write_tone_wav
from test_audio_backends import add_sink

CARD = "fpp_alsa_test"


def sink_state(audio, sink):
    """(volume %, muted) of `sink`, as PipeWire reports it."""
    vol = subprocess.run(["pactl", "get-sink-volume", sink], env=audio.env, capture_output=True,
                         text=True, timeout=10).stdout
    mute = subprocess.run(["pactl", "get-sink-mute", sink], env=audio.env, capture_output=True,
                          text=True, timeout=10).stdout
    levels = {int(p) for p in re.findall(r"(\d+)%", vol)}
    return (levels.pop() if len(levels) == 1 else sorted(levels)), "yes" in mute


def wait_for_sink(audio, want, what, timeout=10):
    deadline = time.monotonic() + timeout
    while True:
        got = sink_state(audio, CARD)
        if got == want:
            return
        assert time.monotonic() < deadline, f"{what}: the card sink is at {got}"
        time.sleep(0.2)


def start(fppd, audio):
    """fppd on the PipeWire backend with an FPP card sink, playing a long
    tone into it: a null sink takes a volume only while it runs."""
    add_sink(audio, CARD, ["FL", "FR"])
    fppd.settings(PipeWireSinkName=CARD)
    write_tone_wav(os.path.join(fppd.media, "music", "Long.wav"), 40)
    fppd.start()
    fppd.command("Play Media", "Long.wav", "1", "0", "1")
    fppd.wait_for(lambda: any(l.split("\t")[1:2] == [CARD] and "RUNNING" in l for l in subprocess.run(
        ["pactl", "list", "sinks", "short"], env=audio.env, capture_output=True, text=True).stdout.splitlines()),
        timeout=10, what="the card sink to run")


def test_the_master_volume_sets_the_card_sinks_volume(fppd, audio):
    """On the PipeWire backend, /fppd/volume/N sets an FPP card sink
    (fpp_alsa_*) to N% in PipeWire, for each of a few levels, unmuted.

    Regression: 35e5386b7. The PipeWire volume was set only on an audio
    group's combine sink (by wpctl); a box playing straight to a card sink
    had only its card's hardware mixer turned, and PipeWire's own volume on
    the sink was left where it was."""
    start(fppd, audio)
    for level in (40, 75, 20):
        fppd.post(f"/fppd/volume/{level}")
        wait_for_sink(audio, (level, False), f"the card sink at {level}%")


def test_volume_zero_mutes_the_card_sink_and_a_later_level_unmutes_it(fppd, audio):
    """/fppd/volume/0 leaves the card sink at 0% and muted in PipeWire; the
    next non-zero level unmutes it at that level.

    Regression: 0a56a619d. Volume 0 only turned the level down: the sink
    was never muted."""
    start(fppd, audio)
    fppd.post("/fppd/volume/50")
    wait_for_sink(audio, (50, False), "the card sink at 50%")
    fppd.post("/fppd/volume/0")
    wait_for_sink(audio, (0, True), "the card sink at 0% and muted")
    fppd.post("/fppd/volume/60")
    wait_for_sink(audio, (60, False), "the card sink unmuted at 60%")
