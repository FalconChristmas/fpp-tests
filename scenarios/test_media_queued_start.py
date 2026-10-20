"""A track that starts right behind another, on the persistent PipeWire
output stream: its clock must not start while the last track's audio is
still queued in the stream.

Real card only (run-local.sh --host-audio): a null sink's VM timer wanders
too far to time this. Verified on a Pi 4's headphone jack.
"""

import os

import pytest

from test_media_backlog import _song_offsets


def test_back_to_back_songs_start_in_step(fppd, audio):
    """Back-to-back sequence+media songs: the second and third start with
    the lights where the first started them, against the sound.

    Regression: f9c588424. A track that started behind another fed the
    stream behind what that one left in it (the feed's lead, the silence
    pushed behind a stopped track, PipeWire's buffer), while its position
    ran from PLAYING regardless, so the lights led the sound for the whole
    of every song after the first."""
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    offs = _song_offsets(fppd, audio, 3, 8, settings={"PipeWireKeepOutputOpen": "1"})
    assert None not in offs, f"a song's start was not seen on the wire or heard: {offs}"
    first, later = offs[0], offs[1:]
    assert max(abs(o - first) for o in later) <= 40, \
        f"songs after the first start out of step with it (lights minus sound, ms): {offs}"


def test_a_resumed_song_starts_in_step(fppd, audio):
    """A sequence+media song interrupted by Insert Playlist Immediate (a
    short media-only playlist) and resumed: after the resume the lights
    hold the offset to the sound they had before the interruption.

    Regression: f9c588424. The resumed track queued behind the inserted
    one's leftovers in the persistent output stream (the feed's lead, the
    silence pushed behind the stopped track) while its clock ran from
    PLAYING: the lights led the sound by ~180 ms for the rest of the song."""
    from audio import write_tone_wav
    from ddp import DdpReceiver
    from fseq import unique_frames, write_fseq
    from show import CHANNELS, ddp_output, playlist
    import statistics
    import time
    if not os.environ.get("FPP_TESTS_HOST_AUDIO"):
        pytest.skip("needs a real sound card: run-local.sh --host-audio")
    secs = 16
    frames = unique_frames(secs * 20, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs, amplitude=0.3,
                   bursts=[(k, 0.1) for k in range(1, secs, 2)])
    write_tone_wav(os.path.join(fppd.media, "music", "Break.wav"), 1.5, bursts=[])
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("playlists/Break.json", playlist("Break", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Break.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", PipeWireKeepOutputOpen="1")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        rec = audio.record(rate=8000)
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: any(d[:CHANNELS] == frames[4 * 20] for _, d in rx.snapshot()),
                      timeout=15, interval=0.02, what="the song to reach 4 s")
        fppd.command("Insert Playlist Immediate", "Break", "0", "0", "false")
        time.sleep(secs + 2)
        samples = rec.stop()
        received = rx.snapshot()
    first_seen = {}
    for t, d in received:
        for k in range(1, secs, 2):
            if d[:CHANNELS] == frames[k * 20]:
                first_seen.setdefault(k, t)
    thr = max(abs(x) for x in samples) * 0.3
    onsets, quiet = [], 0
    for i, x in enumerate(samples):
        if abs(x) > thr and quiet > rec.rate * 0.5:
            onsets.append(rec.time_of(i))
        quiet = 0 if abs(x) > thr else quiet + 1
    offs = {}
    for a in onsets:
        k, t = min(first_seen.items(), key=lambda kv: abs(kv[1] - a))
        if abs(t - a) < 0.6:
            offs.setdefault(k, round((t - a) * 1000))
    print(f"lights minus audio per burst second (ms): {offs}")
    before = [o for k, o in offs.items() if k < 4]
    after = [o for k, o in offs.items() if k > 4]
    assert before and len(after) >= 3, f"too few bursts matched to frames: {offs}"
    moved = statistics.median(after) - statistics.median(before)
    assert abs(moved) <= 40, f"after the resume the lights moved {moved:.0f} ms against the sound: {offs}"
