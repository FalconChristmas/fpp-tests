"""A video file played where there is nothing to show its picture: what fppd
says about it."""

import os
import time

from show import status
from test_video import make_video

MISLEADING = ("missing a plug-in", "Internal data stream error", "within 15000ms",
              "PipeWire restart")


def test_a_video_only_file_with_no_video_output_says_it_has_no_audio(fppd, audio):
    """Play Media of a video with no audio track and the video output
    disabled: fppd.log says the file has no playable audio and no video
    output, the player goes idle, and nothing blames a missing GStreamer
    plug-in, a corrupt stream or a PipeWire restart.

    Regression: 0a0eabf1b. The audio-only fallback pins decodebin to audio
    caps, so a file with no audio failed autoplug and was logged as "Your
    GStreamer installation is missing a plug-in", then the demuxer's
    "Internal data stream error", then "pipeline never reached PLAYING
    within 15000ms ... A PipeWire restart under a running fppd does this"
    -- for a state-change failure that returned at once (#2839)."""
    make_video(os.path.join(fppd.media, "videos", "Silent.mkv"), seconds=4, audio=False)
    fppd.settings(VideoOutput="--Disabled--")
    fppd.start()
    fppd.command("Play Media", "Silent.mkv", "1", "0", "1", "--Disabled--")
    fppd.wait_for(lambda: "has no playable audio stream" in fppd.log(), timeout=15,
                  what="fppd to say the file has no audio")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                  interval=0.2, what="the player to go idle")
    time.sleep(1)
    log = fppd.log()
    said = [l for l in log.splitlines() if any(m in l for m in MISLEADING)]
    assert not said, "fppd blamed something else:\n" + "\n".join(said)
