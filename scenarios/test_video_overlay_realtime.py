"""A video played to a pixel overlay model, on a box short of CPU: the
media keeps to the clock, and the model goes on showing the picture.

The overload is made, not hoped for: fppd's threads and some busy loops all
run on one CPU, so fppd gets a fraction of it however fast the host is.
"""

import os
import subprocess
import sys
import time

from show import ddp_output, playlist
from test_video import make_video

W, H = 64, 32
MODEL = "Matrix"
HOGS = 2


def model():
    return {"Name": MODEL, "Type": "Channel", "StartChannel": 1, "ChannelCount": W * H * 3,
            "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": H, "StrandsPerString": 1}


class Starved:
    """Every thread fppd has, and `hogs` busy loops, on the last CPU: fppd
    gets about 1/(hogs + 1) of it. Threads fppd starts later (GStreamer's)
    inherit the CPU from the thread that starts them."""

    def __init__(self, pid, hogs):
        cpu = max(os.sched_getaffinity(0))
        for tid in os.listdir(f"/proc/{pid}/task"):
            try:
                os.sched_setaffinity(int(tid), {cpu})
            except OSError:
                pass  # a thread that has just ended
        loop = f"import os\nos.sched_setaffinity(0, {{{cpu}}})\nwhile True:\n    pass\n"
        self.procs = [subprocess.Popen([sys.executable, "-c", loop]) for _ in range(hogs)]

    def close(self):
        for p in self.procs:
            p.kill()
            p.wait()


def position(fppd):
    """(monotonic time, the playlist's media position in seconds) or None."""
    s = fppd.get("/fppd/status")
    ms = s.get("milliseconds_elapsed")
    if s.get("status_name") != "playing" or ms in (None, ""):
        return None
    return time.monotonic(), int(ms) / 1000.0


def test_a_video_to_a_model_keeps_to_the_clock_when_the_cpu_cannot_keep_up(fppd, audio):
    """A 4K video plays to a 64x32 overlay model with fppd held to a third
    of one CPU. Over 25 s of playback the media position keeps pace with the
    clock, and the model shows the picture throughout.

    Before the fix this played in step for about 13 s, until the queues
    filled, then fell 0.7 s behind every 2 s (3.5 s by the end). With it,
    the position stays on time, at a sixth of a CPU too. Starved further
    than a third, the parent doesn't even preroll.

    Regression: 64de6dd57. The overlay branch converted each whole decoded
    frame to RGB before scaling it to the model, and its appsink rendered
    every late frame rather than dropping it. A box that couldn't convert in
    real time held the demuxer up behind the full video queue, the sound
    starved, and the position -- with the lights following it -- fell
    further behind the clock for the rest of the track.

    The file is static 4K VP8, cheap to decode and dear to convert, so this
    guards the conversion order. The other half of the fix -- late frames
    dropped and skipped through QoS, which keeps a box on time that can't
    even decode a file in real time -- needs a decoder that skips late
    frames (avdec_h264), which this image doesn't have; it was verified on a
    Pi 5 with a 4K60 H.264 file instead (6 s behind in a minute before, on
    time after)."""
    make_video(os.path.join(fppd.media, "videos", "Big.mkv"), seconds=40, width=3840, height=2160,
               fps=30)
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.write("playlists/Big.json", playlist("Big", [
        {"type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Big.mkv", "videoOut": MODEL}]))
    fppd.settings(DisableFakeNetworkBridges="1", LogLevel_MediaOut="debug")
    fppd.start()

    starved = Starved(fppd.proc.pid, HOGS)
    try:
        fppd.command("Start Playlist", "Big", "false", "false")
        first = fppd.wait_for(lambda: (p := position(fppd)) and p[1] >= 3 and p, timeout=30,
                              interval=0.25, what="the video to play for 3 s")
        last = first
        while last[0] - first[0] < 25:
            time.sleep(0.5)
            p = position(fppd)
            assert p, f"the video stopped {last[1]:.1f} s in\n{fppd.tail()}"
            last = p
            print(f"wall {last[0] - first[0]:5.1f}  played {last[1] - first[1]:5.1f}")
            data = fppd.get(f"/overlays/model/{MODEL}/data").get("data", [])
            assert any(data), f"the model is dark {last[1]:.1f} s into the video"
    finally:
        starved.close()

    wall = last[0] - first[0]
    played = last[1] - first[1]
    assert wall - played < 1.0, (f"the video played {played:.1f} s in {wall:.1f} s: it fell "
                                 f"{wall - played:.1f} s behind the clock")
