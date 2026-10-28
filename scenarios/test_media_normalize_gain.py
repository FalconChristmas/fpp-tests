"""The File Manager's Normalize: a per-song gain in config/media_gain.json
that fppd applies at playback through the GStreamer volume element, heard by
recording the audio fixture's null sink.

Each level is measured against the same tone played with no entry, so the
checks hold at a device's own volume (run-local.sh --host-audio) too."""

import json
import math
import os
import statistics
import time

import shims
from audio import RATE, rms_windows, write_tone_wav
from show import status

GAINS = "config/media_gain.json"


def level(fppd, audio, name, seconds=3):
    """The steady RMS of `name` played with Play Media."""
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the player to be idle")
    rec = audio.record()
    fppd.command("Play Media", name, "1", "0", "1")
    time.sleep(seconds + 1.5)
    samples = rec.stop()
    loud = [i for i, x in enumerate(samples) if abs(x) > 0.01]
    assert loud, f"nothing was heard from {name}"
    body = samples[loud[0] + int(0.5 * RATE):loud[-1] - int(0.5 * RATE)]
    return statistics.fmean(r for _, r in rms_windows(body, 0.1))


def tones(fppd, *names):
    """Identical 3 s half-scale tones; their size, for a media_gain.json entry."""
    for n in names:
        path = write_tone_wav(os.path.join(fppd.media, "music", n), 3, freq=1000, amplitude=0.5)
    return os.path.getsize(path)


def db(ratio):
    return 20 * math.log10(ratio)


def test_a_normalized_song_plays_at_its_stored_gain(fppd, audio):
    """A song with a media_gain.json entry of -6 dB plays 6 dB below the same
    tone without one; an entry whose size no longer matches the file (the song
    was replaced) is ignored.

    Feature: 438a97076 (File Manager: replace MP3Gain with loudness Normalize)."""
    size = tones(fppd, "Plain.wav", "Quiet.wav", "Replaced.wav")
    fppd.write(GAINS, {
        "Quiet.wav": {"gainDb": -6.0, "size": size},
        "Replaced.wav": {"gainDb": -6.0, "size": size + 1},
    })
    fppd.start()
    plain = level(fppd, audio, "Plain.wav")
    quiet = level(fppd, audio, "Quiet.wav")
    replaced = level(fppd, audio, "Replaced.wav")
    if audio.unity:
        assert 0.32 <= plain <= 0.39, f"plain level {plain:.3f}, expected 0.354"
    assert -6.6 <= db(quiet / plain) <= -5.4, f"Quiet.wav played {db(quiet / plain):+.1f} dB, expected -6"
    assert abs(db(replaced / plain)) <= 0.6, \
        f"Replaced.wav played {db(replaced / plain):+.1f} dB: a stale entry was applied"


def test_a_changed_media_gain_json_takes_effect_at_the_next_play(fppd, audio):
    """fppd parses media_gain.json once and again whenever FileMonitor sees it
    change. Each way it changes is used the next time the song starts: edited
    in place (same inode), replaced by a rename the way the File Manager
    writes it, and deleted.

    Regression guard for 5007add16 (Normalize: media_gain.json is parsed
    when it changes, not at every song start): a watcher that missed a change
    would keep playing the old gain. The delete is heard since 9c24621b0."""
    size = tones(fppd, "Plain.wav", "Song.wav")
    fppd.write(GAINS, {"Song.wav": {"gainDb": -6.0, "size": size}})
    fppd.start()
    plain = level(fppd, audio, "Plain.wav")

    def heard(want, how):
        got = db(level(fppd, audio, "Song.wav") / plain)
        assert want - 0.6 <= got <= want + 0.6, f"{how}: played {got:+.1f} dB, expected {want:+.0f}"

    heard(-6, "as first written")

    path = os.path.join(fppd.media, GAINS)
    ino = os.stat(path).st_ino
    with open(path, "r+") as f:
        text = f.read().replace("-6.0", "-9.0")
        f.seek(0)
        f.write(text)
    assert os.stat(path).st_ino == ino and json.load(open(path))["Song.wav"]["gainDb"] == -9.0
    heard(-9, "after an edit in place")

    with open(path + ".tmp", "w") as f:
        json.dump({"Song.wav": {"gainDb": -3.0, "size": size}}, f)
    os.replace(path + ".tmp", path)
    heard(-3, "after a rename over it")

    os.unlink(path)
    heard(0, "after it was deleted")


def test_media_gain_json_is_read_once_for_many_plays(fppd, audio):
    """Three plays of a normalized song with media_gain.json left alone read
    the file once; readtrace.c records every read of it. The next test shows
    each change is still heard at the following play.

    Regression: 5007add16. LookupNormalizeGain() read and parsed the whole
    gain file every time a song or video started."""
    trace = os.path.join(fppd.media, "tmp", "readtrace.log")
    size = tones(fppd, "Song.wav")
    fppd.write(GAINS, {"Song.wav": {"gainDb": -6.0, "size": size}})
    fppd.start(preload=[shims.build("readtrace.c")],
               extra_env={"READTRACE_SUFFIX": "/media_gain.json", "READTRACE_FILE": trace})
    for _ in range(3):
        level(fppd, audio, "Song.wav", seconds=1)
    reads = open(trace).read().splitlines() if os.path.exists(trace) else []
    assert len(reads) == 1, f"media_gain.json was read {len(reads)} times for 3 plays"
