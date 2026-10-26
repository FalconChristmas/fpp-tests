"""The banner a media file that won't play raises when the fault is the
file's own: cut off, or not media at all. The other two kinds need what a
container hasn't got: a video output that fails needs a display, and a
stall can't be made here (with the PipeWire daemon stopped, fppd's own
output stream keeps the position moving, so the watchdog never fires).

Feature: a67eb306b. Before it a damaged file stopped with only a log
line."""

import os
import subprocess

import pytest



def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def banner(fppd, text):
    return next((w for w in warnings(fppd) if text in w), None)


def write_mp4(path, seconds):
    """`seconds` of a tone as MP3 in an ordinary (not fragmented) MP4, the
    moov after the samples, as mp4mux writes it by default."""
    r = subprocess.run(["gst-launch-1.0", "-q", "audiotestsrc", f"num-buffers={seconds * 48000 // 1024}",
                        "samplesperbuffer=1024", "!", "audio/x-raw,rate=48000,channels=1", "!",
                        "audioconvert", "!", "lamemp3enc", "!", "mpegaudioparse", "!",
                        "mp4mux", "!", "filesink", f"location={path}"],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make an MP4 (lamemp3enc, mp4mux): {r.stderr.strip()[-300:]}")


def test_a_cut_off_mp4_says_the_file_is_damaged(fppd, audio):
    """Play Media of an MP4 cut off before its index (a half-finished
    upload) raises "Can't play Cut.mp4: the file looks damaged ...", and
    not the banner for a file that has no audio at all."""
    path = os.path.join(fppd.media, "music", "Cut.mp4")
    write_mp4(path, 4)
    with open(path, "r+b") as f:
        f.truncate(os.path.getsize(path) * 6 // 10)
    fppd.start()
    try:
        fppd.command("Play Media", "Cut.mp4", "1", "0", "1")
    except Exception:
        pass  # refusing it is fine; the banner is what is under test
    w = fppd.wait_for(lambda: banner(fppd, "Can't play Cut.mp4"), timeout=15, interval=0.5,
                      what="the damaged-file banner")
    assert "looks damaged or is not a media file" in w, w
    assert not banner(fppd, "No playable audio"), warnings(fppd)


def test_a_file_that_is_not_media_says_so(fppd, audio):
    """Play Media of a .mp3 that is random bytes raises the damaged-file
    banner naming it."""
    with open(os.path.join(fppd.media, "music", "Noise.mp3"), "wb") as f:
        f.write(os.urandom(64 * 1024))
    fppd.start()
    try:
        fppd.command("Play Media", "Noise.mp3", "1", "0", "1")
    except Exception:
        pass
    w = fppd.wait_for(lambda: banner(fppd, "Can't play Noise.mp3"), timeout=15, interval=0.5,
                      what="the damaged-file banner")
    assert "looks damaged or is not a media file" in w, w
