"""Video group members (VideoOutputManager) against the races and
teardowns around them: parking between videos, stopping, and the display
outputs a video drives.

Uses test_video's media, model and consumer helpers; see that module.
"""

import os
import subprocess
import time

import pytest

import shims
from show import playlist, status
from test_video import (MODEL, hdmi_consumer, make_video, overlay_consumer, play_to_end, setup,
                        wait_for_bars)


def gst_shim(source):
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0"],
                           capture_output=True, text=True)
    return shims.build(source, libs=("-ldl", *flags.stdout.split()))


def test_a_parked_member_stopped_while_its_pause_is_under_way(fppd, audio):
    """An overlay member parked as its video ends, and stopped while the
    park's pause is still under way (vid_statehold.c holds the pause 1.5 s; a video
    on slot 2 stops the member parked on slot 1's channel): the teardown
    waits for the pause, so the member's pipeline ends in NULL, not PAUSED
    again.

    Regression: 348a29b29. Nothing ordered the park's PAUSED and the
    teardown's NULL, each on a thread of its own: the PAUSED landed after
    the NULL and brought the pipeline back up after its teardown (with a
    display member, kmssink and all after its DRM lease went back), to sit
    there with no owner. The shim reports a pause that finds the pipeline
    already NULL. Its other half, Shutdown() waiting for the teardown
    threads, isn't checked here."""
    make_video(os.path.join(fppd.media, "videos", "One.mkv"), seconds=2)
    make_video(os.path.join(fppd.media, "videos", "Two.mkv"), seconds=4)
    setup(fppd, [overlay_consumer()])
    held = os.path.join(fppd.media, "tmp", "statehold.log")
    fppd.start(preload=[gst_shim("vid_statehold.c")],
               extra_env={"STATEHOLD_LOG": held, "STATEHOLD_MS": "1500", "STATEHOLD_HAS": "sink"})
    play_to_end(fppd, "One.mkv")
    fppd.wait_for(lambda: os.path.exists(held), timeout=5, interval=0.05,
                  what="the member's park to pause it (precondition)")
    fppd.command("Play Media", "Two.mkv", "1", "0", "2", "HDMI-A-1")
    wait_for_bars(fppd)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.2,
                  what="the second video to end")
    time.sleep(2)
    holds = open(held).read()
    assert "revived" not in holds, f"a park paused the member after its teardown set it to NULL: {holds}"


def test_a_video_stopped_before_its_members_start_leaves_them_stopped(fppd, audio):
    """A video stopped while its playback thread is on its way into
    StartConsumers() (a shim holds the CMA check at its top 1.5 s): its
    overlay member is never started, so the model stays off after the stop.

    Regression: 200d60b02. The deferred start thread checked its cancel
    token and then called StartConsumers(); a Stop in between ran
    StopConsumers() with nothing to stop, and the member then started
    against the stopped video and ran until the next one, drawing its
    timeout's black frames over the model. Its other half, the SAP
    announcer's walk of the consumers racing Reload(), isn't checked here."""
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=10)
    setup(fppd, [overlay_consumer()])
    held = os.path.join(fppd.media, "tmp", "cmahold.log")
    fppd.start(preload=[shims.build("vid_cmahold.c")],
               extra_env={"CMAHOLD_LOG": held, "CMAHOLD_MS": "1500"})
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: os.path.exists(held), timeout=10, interval=0.02,
                  what="playback to reach StartConsumers() (precondition)")
    fppd.command("Stop Media Slot", "1", timeout=10)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10, interval=0.1,
                  what="the player to go idle")
    fppd.wait_for(lambda: "done" in open(held).read(), timeout=5, interval=0.1,
                  what="the held check to finish")
    time.sleep(3)
    active = fppd.get(f"/overlays/model/{MODEL}")["isActive"]
    started = [l for l in fppd.log().splitlines() if "Started 1 on-demand consumer" in l]
    assert not active and not started, \
        f"the member started after its video was stopped: model active={active}, {started}"


def test_a_low_cma_wait_holds_up_no_video_start(fppd, audio):
    """A camera group (an HDMI member showing a live source) coming back
    after a video, with CMA short (vid_cmahold.c reports 1 MB free) and its
    own teardown from standing aside still under way (vid_statehold.c holds
    its NULL 20 s): a video started on slot 2 while it comes back (on no
    display, so it claims none from the camera) starts at once.

    Regression: 0280d60ea. StartConsumer() waited, up to 3 s, for pending
    teardowns when CMA was short, holding VideoOutputManager's lock, and
    media playback's Start() asks the manager for its display members under
    that lock while holding mediaOutputLock: the video's start, and with it
    status and MultiSync, sat out the wait. The parent's video playback
    doesn't run to its end in a container, so the red is a revert on master."""
    from test_video import SOURCE, fake_kms_env, kms_events, source
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    make_video(os.path.join(fppd.media, "videos", "Two.mkv"), seconds=2)
    camera = hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)
    member = dict(hdmi_consumer(2, source=None, connector_id=77, card="/dev/dri/card9", group=4),
                  streamSlots=[1])
    setup(fppd, [camera, member], [source("videotestsrc", pattern="smpte")])
    held = os.path.join(fppd.media, "tmp", "statehold.log")
    env = fake_kms_env(fppd, STATEHOLD_LOG=held, STATEHOLD_MS=20000, STATEHOLD_TO="NULL",
                       STATEHOLD_FROM="any", STATEHOLD_HAS="sink", CMAHOLD_FREE_KB=1024)
    fppd.start(preload=[gst_shim("vid_statehold.c"), shims.build("vid_cmahold.c")], extra_env=env)
    fppd.wait_for(lambda: [e for e in kms_events(fppd) if e[0] == "frame" and e[1] == "sink"],
                  timeout=20, what="the camera's first frame")
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: os.path.exists(held), timeout=5, interval=0.05,
                  what="the camera's teardown for the video (precondition)")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.1,
                  what="the video to end")
    fppd.wait_for(lambda: "CMA low" in fppd.log().split("Four.mkv")[-1] and "'HDMI: 1'" in
                  fppd.log().split("CMA low")[-1][:200], timeout=15, interval=0.05,
                  what="the camera's comeback to find CMA short (precondition)")
    asked = time.monotonic()
    fppd.command("Play Media", "Two.mkv", "1", "0", "2", "HDMI-A-1", timeout=10)
    took = time.monotonic() - asked
    assert took < 1.0, f"slot 2's Play Media took {took:.1f} s, waiting out the camera's CMA wait"


def test_a_device_memory_frame_with_padded_rows_converts_whole(fppd, audio):
    """A video whose decoder hands out its frames as a hardware decoder does
    -- in device memory, with padded rows that only the frame's GstVideoMeta
    describes (fakehwdec.c) -- played straight to an overlay model: the
    model shows the bars where they are.

    Regression: 0110e05a7. The copy guard that brings a device frame into
    system memory before videoconvert reads it (998ed3e3b) copied it with
    gst_buffer_copy_into(), which leaves out the GstVideoMeta (a "memory"
    meta), so videoconvert read the copy with the caps' default layout: the
    picture sheared row by row, as a Pi 4's padded HEVC frames did."""
    from test_video import fake_kms_env
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=8)
    setup(fppd, [])
    env = fake_kms_env(fppd)
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0", "gstreamer-video-1.0",
                            "gstreamer-allocators-1.0"], capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the GStreamer video or allocators development files are not installed")
    so = shims.build("fakehwdec.c", libs=("-ldl", *flags.stdout.split()))
    os.symlink(so, os.path.join(env["GST_PLUGIN_SYSTEM_PATH_1_0"], "libgstfakehwdec.so"))
    frames = os.path.join(fppd.media, "tmp", "fakehwdec.log")
    env["FAKEHWDEC_LOG"] = frames
    fppd.start(extra_env=env)
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", MODEL)
    fppd.wait_for(lambda: os.path.exists(frames), timeout=10, interval=0.1,
                  what="the fake device-memory decoder to decode (precondition)")
    wait_for_bars(fppd)
    fppd.command("Stop Media Slot", "1", timeout=10)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10, interval=0.1,
                  what="the video to stop")


def test_two_displays_each_show_their_half_of_one_video(fppd, audio):
    """A 320x180 video played to a group whose two HDMI members are given
    its left and right halves: each display (vid_kmscaps.c) gets a 160x180
    picture, from its first frame on.

    Feature: f5b97c533 (a region per video output; before it every display
    showed the whole picture). The Video Output Groups page's translation
    of a region into these fractions (pipewire.php) isn't checked here."""
    from test_video_scaling import kms_env
    make_video(os.path.join(fppd.media, "videos", "Wide.mkv"), seconds=4, width=320, height=180)
    left = dict(hdmi_consumer(1, source=None, connector_id=77, card="", group=4),
                crop={"x": 0.0, "y": 0.0, "width": 0.5, "height": 1.0})
    right = dict(hdmi_consumer(2, source=None, connector_id=78, card="", group=4),
                 crop={"x": 0.5, "y": 0.0, "width": 0.5, "height": 1.0})
    setup(fppd, [left, right])
    log = os.path.join(fppd.media, "tmp", "vidkms.log")
    fppd.start(extra_env=kms_env(fppd))
    fppd.command("Play Media", "Wide.mkv", "1", "0", "1", "HDMI-A-1")

    def firsts():
        try:
            with open(log) as f:
                lines = [l.split() for l in f if l.startswith("shape ")]
        except FileNotFoundError:
            return None
        seen = {}
        for l in lines:
            seen.setdefault(int(l[2]), tuple(int(v) for v in l[3:7]))
        return seen if len(seen) == 2 else None
    seen = fppd.wait_for(firsts, timeout=20, what="both displays' first frames")
    assert (seen[77][:2], seen[78][:2]) == ((160, 180), (160, 180)), \
        f"the displays got {seen[77][:2]} and {seen[78][:2]}, not each half of 320x180"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.2,
                  what="the video to end")


def test_a_software_decoded_video_reaches_a_display_that_takes_one_format(fppd, audio):
    """A video decoded in software (I420) played to a group's HDMI member
    whose display accepts only a plane format (vid_kmscaps.c: RGBx): the
    display gets the picture, and the video plays to its end.

    Regression: 8ab91f813. The direct display branches linked the decoder
    straight to kmssink, assuming a hardware decoder's NV12; software
    decode's I420 didn't negotiate against the plane, the demuxer stopped
    with not-negotiated and nothing reached the display (every H.264 file
    on a Pi 5, which has no hardware H.264 decoder). Only the per-member
    branch is driven here; the primary and plain direct sinks got the same
    converter.

    Also guards 029642be0, which gave a group's HDMI members that direct
    branch off the video's tee: with no direct branches (a control on
    master) the member's display gets no frame at all."""
    from test_video_scaling import kms_env, shapes
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    setup(fppd, [hdmi_consumer(1, source=None, connector_id=77, card="", group=4)])
    # A playlist entry, not Play Media: the parent's Play Media had no video
    # output (198974f27) and played the file audio only.
    fppd.write("playlists/Video.json", playlist("Video", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Four.mkv"}]))
    fppd.start(extra_env=kms_env(fppd))
    started = time.monotonic()
    fppd.command("Start Playlist", "Video", "false", "false")
    fppd.wait_for(lambda: shapes(fppd), timeout=10, what="the display's first frame")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.2,
                  what="the video to end")
    took = time.monotonic() - started
    assert took >= 3, f"a 4 s video ended after {took:.1f} s"


def test_two_groups_on_one_display_one_saved_with_a_stale_id(fppd, audio):
    """Two enabled video groups that both list the display (HDMI-A-1 on the
    fake card, connector 35), one saved when the connector had another id
    (34), and a video played to them: they are recognised as one display,
    one kmssink drives it, from the first, and fppd says it skipped the
    second.

    Regression: 17111ac96. GetHdmiConsumers() handed back the saved ids, so
    34 and 35 passed as two displays; both resolved to connector 35 when
    their kmssinks were built: the second direct branch's sink collided with
    the first in the bin, and its consumer, not recognised as on a display
    the video drives, put a second kmssink on connector 35. The commit's stale card path is covered with
    f58993128's test, which needs both reverted to go red."""
    import fakedrm
    from fppd import sanitizer
    from test_video import kms_events
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    first = dict(hdmi_consumer(1, source=None, connector_id=35, card="/dev/dri/card0", group=4),
                 connector=fakedrm.CONNECTOR)
    stale = dict(hdmi_consumer(2, source=None, connector_id=34, card="/dev/dri/card0", group=5),
                 connector=fakedrm.CONNECTOR)
    setup(fppd, [first, stale])
    preload, env = fakedrm.start_env(fppd)
    if sanitizer(fppd.tree) == "asan":
        env["ASAN_OPTIONS"] = ("halt_on_error=1:detect_leaks=0:abort_on_error=0:"
                               f"log_path={fppd.media}/logs/asan:max_free_fill_size=65536:free_fill_byte=190")
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", fakedrm.CONNECTOR)
    time.sleep(3)
    fppd.get("/fppd/status", timeout=5)
    sinks = sorted({n for e, n, c, _ in kms_events(fppd) if e == "frame" and c == 35})
    assert len(sinks) == 1, f"connector 35 was driven by {sinks}"
    assert "already driven by an earlier video output" in fppd.log(), \
        "the stale entry for the display was not recognised as the same display"


def test_a_member_saved_with_a_stale_card_path_still_reaches_its_display(fppd, audio):
    """A video played to a group whose HDMI member (HDMI-A-1, the fake
    card's connector 35) was saved with a card path that no longer exists
    (/dev/dri/card1; the display is on card0 now): the member's kmssink
    puts the video on the display's plane anyway.

    Regression: f58993128. The direct kmssink took the saved cardPath, could
    not open it, and got no DRM fd: nothing reached the display."""
    import re
    import fakedrm
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    member = dict(hdmi_consumer(1, source=None, connector_id=35, card="/dev/dri/card1", group=4),
                  connector=fakedrm.CONNECTOR)
    setup(fppd, [member])
    fppd.write("playlists/Video.json", playlist("Video", [{
        "type": "media", "enabled": 1, "playOnce": 0, "mediaName": "Four.mkv"}]))
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    fppd.command("Start Playlist", "Video", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.2,
                  what="the video to end")
    assert re.search(r"^plane \d+ ", fakedrm.log(fppd), re.M), \
        "nothing was put on the display's plane:\n" + fakedrm.log(fppd)[-1500:]


def test_a_youtube_input_fits_its_size_and_frame_rate(fppd, audio):
    """A YouTube video input configured for 320x240 at 10 fps, whose stream
    yt-dlp reports at 60 fps: yt-dlp is asked for the best H.264 stream no
    taller than 240, and the input's pipeline is built for 10 fps (its
    videorate's caps, as handed to gst_parse_launch), and shows the video.

    Regression: 391a73a05. The format asked for was a fixed 240p one
    (229/133), whatever size was configured, and the stream's own frame
    rate replaced the configured one, so the input ran at 60 fps. The rest
    of the commit (persistent members started once their source is ready,
    the Video Input page's presets) isn't checked here."""
    import functools
    import http.server
    import re
    import threading
    from test_video import SOURCE, source, ytdlp_stand_in, yt_dlp_calls
    served = os.path.join(fppd.media, "tmp", "www")
    os.makedirs(served)
    make_video(os.path.join(served, "Bars.mkv"), seconds=30)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=served)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/Bars.mkv"
    try:
        env = ytdlp_stand_in(fppd, f'echo "{url}"\necho 60')
        setup(fppd, [overlay_consumer(SOURCE)],
              [source("urisrc", uri="https://www.youtube.com/watch?v=x", width=320, height=240,
                      framerate=10)])
        fppd.start(extra_env=env)
        wait_for_bars(fppd, timeout=30)
    finally:
        server.shutdown()
    formats = [c[c.index("-f") + 1] for c in yt_dlp_calls(fppd) if "-f" in c]
    assert formats and all("height<=240" in f for f in formats), f"yt-dlp was asked for {formats}"
    started = [l for l in fppd.log().splitlines() if "Starting source 'Test'" in l]
    rates = {m for l in started for m in re.findall(r"framerate=(\d+)/1", l)}
    assert started and rates == {"10"}, f"the input was built for {rates or started} fps, not 10"


def test_a_video_played_to_a_display_puts_its_frames_on_it(fppd, audio):
    """A video played to HDMI-A-1 (connector 35 of the fake card, a display
    on it) with no PipeWire video routing: fppd's own kmssink for that
    connector shows it -- its frames go up on the display's plane -- for
    the video's length.

    Feature: 81abc2dc7 (HDMI video through GStreamer's kmssink, in place of
    VLC's DRM output)."""
    import re
    import fakedrm
    from test_video import kms_events
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=fakedrm.CONNECTOR)
    preload, env = fakedrm.start_env(fppd)
    fppd.start(preload=preload, extra_env=env)
    started = time.monotonic()
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", fakedrm.CONNECTOR)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.2,
                  what="the video to end")
    took = time.monotonic() - started
    frames = [t for e, n, c, t in kms_events(fppd) if e == "frame" and c == 35]
    assert len(frames) >= 20, f"{len(frames)} frames reached connector 35"
    assert frames[-1] - frames[0] >= 3, f"the frames spanned {frames[-1] - frames[0]:.1f} s of a 4 s video"
    assert took >= 3.5, f"a 4 s video ended after {took:.1f} s"
    assert re.search(r"^plane \d+ ", fakedrm.log(fppd), re.M), "nothing went up on the display's plane"
