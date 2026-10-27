"""A media entry's length in fppd's status when TagLib can't give it and
GStreamer learns it only once the file is playing. fppd plays into the
audio fixture's null sink."""

import os
import subprocess

import pytest

import shims
from show import playlist, status


def write_fragmented_m4a_with_length(path, seconds):
    """`seconds` of a 48 kHz mono tone as MP3 in a fragmented MP4, as
    GStreamer's mp4mux writes it: the moov has no samples (so TagLib, which
    reads the moov, finds no length) but an mehd box with the fragments'
    total, which qtdemux reads once the file is open."""
    r = subprocess.run(["gst-launch-1.0", "-q", "audiotestsrc", f"num-buffers={seconds * 48000 // 1024}",
                        "samplesperbuffer=1024", "!", "audio/x-raw,rate=48000,channels=1", "!",
                        "audioconvert", "!", "lamemp3enc", "!", "mpegaudioparse", "!",
                        "mp4mux", "fragment-duration=500", "streamable=true", "!",
                        "filesink", f"location={path}"], capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make a fragmented MP4 (lamemp3enc, mp4mux): {r.stderr.strip()[-300:]}")
    with open(path, "rb") as f:
        assert b"mehd" in f.read(), "mp4mux wrote no mehd"


def test_a_length_only_gstreamer_knows_is_counted_down(fppd, audio):
    """A media entry playing a 10 s fragmented MP4 whose length only
    GStreamer finds (TagLib reads an empty moov), and finds late: fppd's
    first 4 s of asking get no answer (gst_latedur.c), while the file is
    already playing. Its time remaining is still counted down from 10 s:
    from 5 s in, elapsed plus remaining in fppd's status stays at 9 or 10 s
    (each is whole seconds, rounded down).

    Regression: 096093da1. PlaylistEntryMedia::GetLengthInMS() kept the
    first length it worked out. TagLib's was 0, and GStreamer's was not
    known yet when the status first asked, so GetElapsedMS() raised the
    length to the elapsed time and it stayed there: the time remaining
    sat at 0 for the whole track."""
    write_fragmented_m4a_with_length(os.path.join(fppd.media, "music", "Frag.m4a"), 10)
    fppd.write("playlists/Frag.json", playlist("Frag", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Frag.m4a"}]))
    fppd.start(preload=[shims.build("gst_latedur.c")], extra_env={"LATEDUR_MS": "4000"})
    fppd.command("Start Playlist", "Frag", "false", "false")
    seen = []

    def eight_seconds_in():
        st = status(fppd)
        if st.get("status_name") != "playing":
            return None
        elapsed = int(st.get("seconds_elapsed", 0))
        if elapsed >= 5:
            seen.append((elapsed, int(st["seconds_remaining"])))
        return st if elapsed >= 8 else None

    st = fppd.wait_for(eight_seconds_in, timeout=20, interval=0.2, what="8 s of Frag.m4a to play")
    fppd.command("Stop Now")
    assert st.get("current_song") == "Frag.m4a", st
    assert seen and all(e + r in (9, 10) for e, r in seen), f"(elapsed, remaining) from 5 s on: {seen}"


def write_vbr_mp3(path, loud_s, quiet_s):
    """A VBR MP3 (LAME, no Xing header) of loud_s seconds of white noise
    and then quiet_s seconds of near silence: the noise takes LAME's top
    bitrates and the silence its bottom one, so a length estimated from the
    bitrate of the frames read so far comes out short, and grows as the
    quiet frames are read."""
    r = subprocess.run(["gst-launch-1.0", "-q", "audiotestsrc", "wave=white-noise", "volume=0.8",
                        f"num-buffers={loud_s * 48000 // 1024}", "samplesperbuffer=1024", "!",
                        "audio/x-raw,rate=48000,channels=2", "!", "concat", "name=c", "!",
                        "audioconvert", "!", "lamemp3enc", "target=quality", "quality=0", "!",
                        "filesink", f"location={path}",
                        "audiotestsrc", "wave=silence", f"num-buffers={quiet_s * 48000 // 1024}",
                        "samplesperbuffer=1024", "!", "audio/x-raw,rate=48000,channels=2", "!", "c."],
                       capture_output=True, text=True, timeout=120)
    if r.returncode:
        pytest.skip(f"cannot make a VBR MP3 (lamemp3enc, concat): {r.stderr.strip()[-300:]}")


def test_a_vbr_files_total_follows_gstreamers_estimate(fppd, audio):
    """Play Media of a 12 s VBR MP3 (3 s of noise, then near silence; no
    Xing header) whose length GStreamer estimates from the bitrate seen so
    far, so its estimate starts near 4 s and grows as the quiet frames are
    read. The slot's total follows the estimate up, reaching 11 s or more
    before the file ends.

    Regression: 36ca9ad01. The total was set from GStreamer's first
    duration answer and never again, so the slot kept a length of 3-4 s for
    the whole file."""
    import time
    from test_media_commands import slot_status
    write_vbr_mp3(os.path.join(fppd.media, "music", "Vbr.mp3"), 3, 9)
    fppd.start()
    fppd.command("Play Media", "Vbr.mp3", "1", "0", "1", timeout=10)
    totals = []
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        sl = slot_status(fppd, 1) or {}
        if sl.get("status") != "playing":
            if totals:
                break
        else:
            totals.append(sl.get("minutesTotal", 0) * 60 + sl.get("secondsTotal", 0))
        time.sleep(0.25)
    assert totals, "the file never played"
    assert max(totals) >= 11, f"the slot's total stayed at {sorted(set(totals))} s"
