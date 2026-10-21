"""RTSP video inputs against a stand-in camera (vid_rtsp.py) whose SDP each
scenario picks: which of the offered tracks fppd's rtspsrc sets up, and
that the source then shows the camera's picture on an overlay model.

The camera records every SETUP by track index. A source that dies is
restarted (7d85c52d9), so a track may be set up more than once; what
matters is which tracks ever are.
"""

import os
import subprocess
import time

from audio import env as audio_env
from test_video import SOURCE, overlay_consumer, setup, source, wait_for_bars
from vid_rtsp import FakeCamera

JPEG = {"media": "video", "codec": "JPEG"}
H264 = {"media": "video", "codec": "H264"}
PCMU = {"media": "audio", "codec": "PCMU"}


def camera_source(cam, **extra):
    return source("rtspsrc", uri=cam.url, latency=100, **extra)


def test_a_camera_that_lists_audio_first_sets_up_only_its_video(fppd, audio):
    """A camera whose SDP lists an audio track before its video, on a
    source with audio off: fppd sets up only the video track, and the model
    shows the camera's bars.

    Regression: 725b6c1bd. Every track the SDP offered was set up, and
    decodebin, with one sink pad, linked whichever pad came first: here the
    audio, leaving the video pad unlinked, so rtspsrc tore the pipeline down
    ("Internal data stream error ... not-linked") and the preview said "No
    frames"."""
    with FakeCamera([PCMU, JPEG]) as cam:
        setup(fppd, [overlay_consumer(SOURCE)], [camera_source(cam)])
        fppd.start()
        fppd.wait_for(lambda: cam.setups, timeout=20, what="the camera to be asked for a track")
        wait_for_bars(fppd, timeout=20)
        assert set(cam.setups) == {1}, f"tracks set up: {cam.setups} (0 is the audio)"


def test_a_camera_with_two_video_tracks_sets_up_the_first(fppd, audio):
    """A camera offering the same picture as two video tracks (MJPEG and
    H.264, as some do): fppd sets up the first only, says it ignored the
    other, and the model shows the bars.

    Regression: ecb6cffbb. The filter from 725b6c1bd kept every video
    track, so both were set up and the second pad was left unlinked -- the
    same not-linked teardown."""
    with FakeCamera([JPEG, H264]) as cam:
        setup(fppd, [overlay_consumer(SOURCE)], [camera_source(cam)])
        fppd.start()
        fppd.wait_for(lambda: cam.setups, timeout=20, what="the camera to be asked for a track")
        wait_for_bars(fppd, timeout=20)
        assert set(cam.setups) == {0}, f"tracks set up: {cam.setups} (1 is the second video)"
    assert "offers more than one video stream" in fppd.log()


def test_a_camera_with_no_video_track_says_so(fppd, audio):
    """A camera whose SDP has only an audio track, on a source with audio
    on: fppd logs that the stream has no video track and raises a warning
    that says so.

    Regression: ecb6cffbb. The source came up empty and the only sign of it
    was "No frames" in the preview, with nothing in the log."""
    with FakeCamera([PCMU]) as cam:
        setup(fppd, [overlay_consumer(SOURCE)],
              [camera_source(cam, audioEnabled=True, audioPipeWireNodeName="fpp_cam_audio")])
        fppd.start()
        fppd.wait_for(lambda: "offers no video track" in fppd.log(), timeout=20,
                      what="fppd to log that the stream has no video")
        fppd.wait_for(lambda: any("contains no video track" in w
                                  for w in fppd.get("/fppd/status").get("warnings", [])),
                      timeout=10, what="the no-video warning")


def no_video_warning(fppd):
    return any("contains no video track" in w for w in fppd.get("/fppd/status").get("warnings", []))


def test_an_audio_only_camera_with_audio_off_says_it_has_no_video(fppd, audio):
    """A camera whose SDP has only an audio track, on a source with audio
    off: fppd logs that the stream has no video track and raises the
    warning, not rtspsrc's transport complaint. Once the camera offers
    video again, the source's next retry shows its picture and the warning
    comes down.

    Regression: 2e11dbeb2. The audio track was refused, so rtspsrc made no
    pads and "no-more-pads" (ecb6cffbb's report) never fired: it failed
    with "No supported stream was found. You might need to allow more
    transport protocols", and the source retried forever under that, with
    no warning."""
    # Made with the video track, so its producer is running when the camera
    # offers it again; the SDP is audio-only until then.
    with FakeCamera([JPEG]) as cam:
        cam.tracks = [PCMU]
        setup(fppd, [overlay_consumer(SOURCE)], [camera_source(cam)])
        fppd.start()
        fppd.wait_for(lambda: "offers no video track" in fppd.log(), timeout=20,
                      what="fppd to log that the stream has no video")
        fppd.wait_for(lambda: no_video_warning(fppd), timeout=10, what="the no-video warning")
        assert "No supported stream was found" not in fppd.log(), \
            "rtspsrc's transport message was logged as the source's error"
        cam.tracks = [JPEG]
        wait_for_bars(fppd, timeout=30)
        fppd.wait_for(lambda: not no_video_warning(fppd), timeout=10,
                      what="the no-video warning to come down once the camera offers video")


def pw_nodes():
    return subprocess.run(["pw-cli", "ls", "Node"], env=audio_env(), capture_output=True,
                          text=True).stdout


def test_a_cameras_audio_reaches_pipewire_when_enabled(fppd, audio):
    """A camera with a microphone, on a source with audio on: fppd sets up
    both tracks, the model shows the picture, and the camera's sound (a
    1 kHz tone) comes out of the source's own PipeWire node.

    Feature/regression: 232de7878. audioEnabled was honoured for YouTube
    sources only: an RTSP camera was built video-only, its audio track was
    refused, and no audio node ever appeared."""
    import wave
    node = "fpp_cam_audio"
    with FakeCamera([JPEG, PCMU]) as cam:
        setup(fppd, [overlay_consumer(SOURCE)],
              [camera_source(cam, audioEnabled=True, audioPipeWireNodeName=node)])
        fppd.start()
        fppd.wait_for(lambda: cam.setups, timeout=20, what="the camera to be asked for a track")
        wait_for_bars(fppd, timeout=20)
        assert set(cam.setups) == {0, 1}, f"tracks set up: {cam.setups} (1 is the audio)"
        fppd.wait_for(lambda: node in pw_nodes(), timeout=15, what=f"the {node} PipeWire node")
        path = os.path.join(fppd.media, "tmp", "cam.wav")
        rec = subprocess.Popen(["pw-record", "--target", node, "--rate", "48000", "--channels", "1",
                                "--format", "s16", path], env=audio_env(),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        rec.terminate()
        rec.wait(5)
    with wave.open(path) as w:
        data = w.readframes(w.getnframes())
    import struct
    samples = struct.unpack(f"<{len(data) // 2}h", data)
    loud = sum(1 for x in samples if abs(x) > 3000)
    assert loud > 4800, f"{loud} loud samples of {len(samples)} recorded from {node}: the camera's tone did not come through"
