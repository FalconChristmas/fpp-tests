"""The output thread's frame period while media sync pulls the lights back
toward the media position: however far ahead the lights are, frames keep
going out."""

import os
import time

from audio import write_tone_wav
from ddp import DdpReceiver
from fseq import unique_frames, write_fseq
from show import CHANNELS, ddp_output, playlist


def test_lights_far_ahead_of_the_media_keep_sending(fppd, audio):
    """With a media offset of 10 s (the most the setting takes) the media
    position reads 10 s behind the lights for the first seconds of a song, a
    lead of 200 frames: frames still go out at no more than 15 ms over the
    sequence's 50 ms step while sync holds the lights back (the bound here
    leaves room for a busy container's timer jitter).

    Regression: 892cc9230. The slew toward the media position was bounded
    by 15 ms on the lights-behind side only; ahead, each check added time in
    proportion to the lead to the frame period the output thread sleeps
    for, so 200 frames ahead made it 150 ms at once and longer after (with
    it reverted on master: 150 ms gaps here).
    """
    secs = 16
    frames = unique_frames(secs * 20, CHANNELS)
    write_fseq(os.path.join(fppd.media, "sequences", "Song.fseq"), frames)
    write_tone_wav(os.path.join(fppd.media, "music", "Song.wav"), secs, amplitude=0.1)
    fppd.write("playlists/Song.json", playlist("Song", [{
        "type": "both", "enabled": 1, "playOnce": 0,
        "sequenceName": "Song.fseq", "mediaName": "Song.wav"}]))
    fppd.write("config/co-universes.json", ddp_output(CHANNELS))
    fppd.settings(DisableFakeNetworkBridges="1", mediaOffset="9999")
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        fppd.command("Start Playlist", "Song", "false", "false")
        fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing",
                      what="the song to play")
        start = time.monotonic()
        time.sleep(9)
        end = time.monotonic()
        times = [t for t, _ in rx.snapshot(since=start + 1)] + [end]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert len(gaps) > 70, f"only {len(gaps)} frames in 8 s"
    assert max(gaps) < 0.12, f"a {max(gaps) * 1000:.0f} ms gap between frames with the lights ahead"
