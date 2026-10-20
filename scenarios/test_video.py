"""Video routing: media and live sources into overlay models and RTP.

fppd moves video inside the process over GStreamer's inter elements: a
playing file publishes on fppd_video_stream_<slot>, a video input source on
its own node name, and the consumers in pipewire-video-consumers.json read
from them (VideoOutputManager, VideoInputManager). A consumer of type
overlay scales the picture into a pixel overlay model, which is what these
scenarios read back; an rtp consumer sends it as RTP.

The pictures are videotestsrc's SMPTE bars, so where each bar lands can be
checked: seven bars across the top two thirds, white (75%), yellow, cyan,
green, magenta, red and blue.

The configuration files are the ones the Video Groups and Video Input pages
generate (pipewire.php), written directly.
"""

import os
import socket
import struct
import subprocess
import time
import urllib.error
import urllib.request

import pytest

from fppd import API
from show import ddp_output, status

# 4:3, as the videos are: a consumer keeps the picture's shape and pads the
# rest of the model black.
W, H = 32, 24
MODEL = "Vid"
SINK = "fpp_video_bus"
# Each SMPTE bar's colour as (red, green, blue) on or off.
BARS = [(1, 1, 1), (1, 1, 0), (0, 1, 1), (0, 1, 0), (1, 0, 1), (1, 0, 0), (0, 0, 1)]


def make_video(path, seconds=4, pattern="smpte", width=320, height=240, fps=10, audio=True,
               lead=None):
    """A VP8 Matroska file of videotestsrc's `pattern` (the image has no
    H.264 decoder), with a quiet Vorbis tone track unless `audio` is
    False. `lead` = (pattern, seconds) puts that pattern first, so the
    file is lead + `seconds` long."""
    caps = f"video/x-raw,width={width},height={height},framerate={fps}/1"
    total = seconds + (lead[1] if lead else 0)
    cmd = ["gst-launch-1.0", "-q", "matroskamux", "name=mux", "!", "filesink", f"location={path}",
           "concat", "name=cat", "!", "vp8enc", "deadline=1", "!", "mux."]
    for pat, secs in ([lead] if lead else []) + [(pattern, seconds)]:
        cmd += ["videotestsrc", f"num-buffers={int(secs * fps)}", f"pattern={pat}", "!", caps, "!", "cat."]
    if audio:
        cmd += ["audiotestsrc", "volume=0.1", "samplesperbuffer=4410", f"num-buffers={int(total * 10)}",
                "!", "audio/x-raw,rate=44100,channels=2", "!", "audioconvert", "!", "vorbisenc",
                "!", "mux."]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode:
        pytest.skip(f"cannot make a test video (gst-launch-1.0): {r.stderr.strip()[-300:]}")


def model():
    return {"Name": MODEL, "Type": "Channel", "StartChannel": 1, "ChannelCount": W * H * 3,
            "ChannelCountPerNode": 3, "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": H, "StrandsPerString": 1}


def setup(fppd, consumers, sources=None):
    """The overlay model, a DDP output so the channel data is sent, the
    consumers and (optionally) the video input sources."""
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.write("config/pipewire-video-consumers.json", consumers)
    if sources is not None:
        fppd.write("config/pipewire-video-input-sources-gen.json", sources)
    fppd.settings(DisableFakeNetworkBridges="1", PipeWireVideoSinkName=SINK, VideoOutput="HDMI-A-1")


SOURCE = "fpp_video_src_1_test"


def source(kind, **extra):
    """One video input source, as the Video Input page's Apply generates it."""
    s = {"id": 1, "name": "Test", "type": kind, "pipeWireNodeName": SOURCE, "enabled": True,
         "width": 320, "height": 240, "framerate": 10}
    s.update(extra)
    return s


def rtp_consumer(port, encoding, source=SOURCE, group=2):
    return {"groupId": group, "groupName": "RTP", "groupNodeName": f"fpp_video_group_{group}_rtp",
            "type": "rtp", "pipeWireNodeName": f"fpp_video_group_{group}_rtp_m1_rtp",
            "address": "127.0.0.1", "port": port, "encoding": encoding, "sourceNode": source,
            "name": "RTP: 127.0.0.1"}


def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def overlay_consumer(source=None, group=1):
    c = {"groupId": group, "groupName": "Test", "groupNodeName": f"fpp_video_group_{group}_test",
         "type": "overlay", "pipeWireNodeName": f"fpp_video_group_{group}_test_m1_overlay",
         "overlayModel": MODEL, "name": f"Overlay: {MODEL}"}
    if source:
        c["sourceNode"] = source
    return c


def pixels(fppd):
    """The model's pixels as rows of (r, g, b)."""
    d = fppd.get(f"/overlays/model/{MODEL}/data")["data"]
    return [[tuple(d[(y * W + x) * 3:(y * W + x) * 3 + 3]) for x in range(W)] for y in range(H)]


def bars(px):
    """The on/off colour at the middle of each of the seven bars, a third of
    the way down."""
    row = px[H // 3]
    return [tuple(int(c > 96) for c in row[int((i + 0.5) * W / 7)]) for i in range(7)]


def shows_bars(fppd, seen=None):
    """The model shows the bars; `seen` collects what it showed instead."""
    try:
        got = bars(pixels(fppd))
    except (KeyError, TypeError, IndexError) as e:
        if seen is not None:
            seen.append(repr(e)[:200] + repr(fppd.get(f"/overlays/model/{MODEL}/data"))[:300])
        return False
    if seen is not None and got not in seen:
        seen.append(got)
        seen.append(pixels(fppd)[H // 3][::4])
    return got == BARS


def wait_for_bars(fppd, timeout=15):
    seen = []
    try:
        fppd.wait_for(lambda: shows_bars(fppd, seen), timeout=timeout, interval=0.2,
                      what="the model to show the bars")
    except TimeoutError as e:
        raise AssertionError(f"{e}; it showed {seen}") from None


def test_a_playing_video_reaches_an_overlay_model(fppd, audio):
    """Play Media of a video to the HDMI output, with an overlay consumer in
    the video group: the model shows the video's bars, in order, while it
    plays, and the model is left as it was when the video ends.

    Regression: 3c3784f46. Nothing published playback's video on the slot's
    channel: the overlay member built intervideosrc with an empty channel
    name, which doesn't parse, and the model never showed a frame."""
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"))
    setup(fppd, [overlay_consumer()])
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "HDMI-A-1")
    wait_for_bars(fppd)
    fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"] == 0, timeout=15,
                  what="the model to be disabled again after the video")


def test_a_video_with_no_sound_plays_at_its_own_speed(fppd, audio):
    """A video with no audio track, to a video group with an overlay
    member and no display: it plays for its length, and the model shows it.

    Regression: 68e888765. With no display there is no kmssink, and with no audio
    track the audio sink is removed, so nothing in the pipeline waited on
    the clock. The 4 s file decoded as fast as it could and ended in a few
    milliseconds, before the overlay consumer had started."""
    make_video(os.path.join(fppd.media, "videos", "Silent.mkv"), seconds=4, audio=False)
    setup(fppd, [overlay_consumer()])
    fppd.start()
    started = time.monotonic()
    fppd.command("Play Media", "Silent.mkv", "1", "0", "1", "HDMI-A-1")
    wait_for_bars(fppd)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                  interval=0.2, what="the video to end")
    took = time.monotonic() - started
    assert took >= 3.5, f"a 4 s video finished after {took:.1f} s"


def test_play_media_default_video_output_follows_the_setting(fppd, audio):
    """Play Media with the video output "--Default--" plays the video to
    the VideoOutput setting's target, here a pixel overlay model directly.

    Regression: decdfeb4e. Play Media passed "--Default--" through as the
    output, where it was taken for the name of a pixel overlay model; there
    was none, and the video was dropped (playlists already resolved it)."""
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"))
    fppd.write("config/co-universes.json", ddp_output(W * H * 3))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [model()]})
    fppd.settings(DisableFakeNetworkBridges="1", VideoOutput=MODEL)
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "--Default--")
    wait_for_bars(fppd)


def test_a_live_test_pattern_reaches_an_overlay_model(fppd, audio):
    """A video input source (videotestsrc, SMPTE bars) and an overlay member
    of a group that takes its video from it: the model shows the bars with
    nothing playing, and the input's preview is a JPEG of it."""
    setup(fppd, [overlay_consumer(SOURCE)], [source("videotestsrc", pattern="smpte")])
    fppd.start()
    wait_for_bars(fppd)

    def preview():
        try:
            with urllib.request.urlopen(f"{API}/videoinput/preview?id=1&width=64", timeout=10) as r:
                return r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError:
            return None
    ctype, jpeg = fppd.wait_for(preview, timeout=10, what="a preview of the input")
    assert ctype == "image/jpeg" and jpeg[:2] == b"\xff\xd8", (ctype, jpeg[:16])


def test_an_rtp_jpeg_stream_reaches_an_overlay_model(fppd, audio):
    """A video input source of type rtpsrc taking JPEG over RTP, fed by a
    sender on this machine: the model shows what was sent."""
    port = free_udp_port()
    setup(fppd, [overlay_consumer(SOURCE)], [source("rtpsrc", port=port, encoding="JPEG")])
    fppd.start()
    sender = subprocess.Popen(
        ["gst-launch-1.0", "-q", "videotestsrc", "is-live=true", "pattern=smpte",
         "!", "video/x-raw,width=320,height=240,framerate=10/1", "!", "jpegenc",
         "!", "rtpjpegpay", "!", "udpsink", "host=127.0.0.1", f"port={port}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        wait_for_bars(fppd, timeout=20)
    finally:
        sender.kill()
        sender.wait()


def test_a_video_file_as_an_input_source(fppd, audio):
    """A video input source of type urisrc pointed at a file: the model
    shows the file's picture."""
    path = os.path.join(fppd.media, "videos", "Bars.mkv")
    make_video(path, seconds=20)
    setup(fppd, [overlay_consumer(SOURCE)], [source("urisrc", uri="file://" + path)])
    fppd.start()
    wait_for_bars(fppd)


@pytest.mark.parametrize("encoding,payload_type", [("mjpeg", 26), ("raw", 96)])
def test_rtp_output_sends_the_source(fppd, audio, encoding, payload_type):
    """An rtp member of a group sends the source's video as RTP to its
    address and port, with the payload type of its encoding, and writes the
    SDP a receiver needs."""
    port = free_udp_port()
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    rx.bind(("127.0.0.1", port))
    rx.settimeout(0.2)
    try:
        consumer = rtp_consumer(port, encoding)
        setup(fppd, [consumer], [source("videotestsrc", pattern="smpte")])
        fppd.start()
        packets = []

        def got_packets():
            # Drain everything waiting: a raw stream is ~800 packets a second.
            try:
                for _ in range(2000):
                    packets.append(rx.recv(65536))
            except socket.timeout:
                pass
            # A raw frame takes ~80 packets: wait for one to end.
            return len(packets) >= 20 and any(p[1] & 0x80 for p in packets)
        fppd.wait_for(got_packets, timeout=20, interval=0, what="RTP packets ending a frame")
    finally:
        rx.close()
    for p in packets:
        assert p[0] >> 6 == 2, f"not RTP version 2: {p[:12].hex()}"
        assert p[1] & 0x7F == payload_type, f"payload type {p[1] & 0x7F}, expected {payload_type}"
    seqs = [struct.unpack(">H", p[2:4])[0] for p in packets]
    # Forward only. A gap is this receiver falling behind (a slow runner
    # drops UDP); a repeat or a step back is a second sender or a restarted one.
    steps = [(b - a) & 0xFFFF for a, b in zip(seqs, seqs[1:])]
    assert all(0 < d < 0x8000 for d in steps), \
        f"sequence numbers go back or repeat: {[(a, b) for a, b in zip(seqs, seqs[1:]) if not 0 < (b - a) & 0xFFFF < 0x8000][:10]}"
    sdp_path = os.path.join(fppd.media, "config", f"rtp_{consumer['pipeWireNodeName']}.sdp")
    with open(sdp_path) as f:
        sdp = f.read()
    assert f"m=video {port} RTP/AVP {payload_type}" in sdp, sdp
    assert "c=IN IP4 127.0.0.1" in sdp, sdp


def test_an_overlay_member_starts_and_stops_with_each_video(fppd, audio):
    """Five short videos in a row: the overlay member starts with each one
    and stops when it ends, and the model shows each of them.

    Regression: d0087b476. StopConsumer locked the mutex inside the member's overlay
    state, then dropped what was often the last reference to that state
    while still holding the lock, so the unlock touched freed memory. Only
    TSan sees that (an unlock of freed memory is invisible to ASan): run
    with --flavor tsan to reproduce it."""
    make_video(os.path.join(fppd.media, "videos", "Short.mkv"), seconds=2)
    setup(fppd, [overlay_consumer()])
    fppd.start()
    for i in range(5):
        fppd.command("Overlay Model Clear", MODEL)
        fppd.command("Play Media", "Short.mkv", "1", "0", "1", "HDMI-A-1")
        try:
            wait_for_bars(fppd)
        except AssertionError as e:
            raise AssertionError(f"video {i + 1}: {e}") from None
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                      interval=0.2, what=f"video {i + 1} to end")
        fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"] == 0, timeout=10,
                      what=f"the model to be released after video {i + 1}")


def test_an_overlay_member_starts_with_the_video_and_playback_ends_on_time(fppd, audio):
    """A 4 s video: the overlay member has its first frame within a moment
    of Play Media, and playback is over when the file is.

    Regression: 7f644bb95. Playback started the group's members only after
    attaching a PipeWire node for the graph and waiting for it -- a 2 s
    timeout on a sink nothing links, which never prerolls, then a 200 ms
    sleep -- so the first ~2.3 s of every video never reached the model.
    That sink never posted EOS either, so playback ran on until a watchdog
    stopped it, 5-10 s late."""
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    setup(fppd, [overlay_consumer()])
    fppd.start()
    started = time.monotonic()
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"], timeout=10,
                  interval=0.05, what="the overlay member's first frame")
    first = time.monotonic() - started
    assert first <= 1.5, f"the overlay member's first frame came {first:.1f} s into the video"
    wait_for_bars(fppd)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                  interval=0.2, what="the video to end")
    took = time.monotonic() - started
    assert took <= 6, f"a 4 s video took {took:.1f} s to end"


def play_to_end(fppd, name, what="the video to end"):
    fppd.command("Play Media", name, "1", "0", "1", "HDMI-A-1")
    wait_for_bars(fppd)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                  interval=0.2, what=what)


def test_back_to_back_videos_reuse_the_overlay_member(fppd, audio):
    """A video started within a few seconds of the last one ending finds
    its overlay member already built (parked, PAUSED) and only sets it
    playing; building one costs about half a second on a BeagleBone. The
    member hands the model back between the two. (fpp f4a1ed3ec; on the
    commit before it, this fails.)"""
    make_video(os.path.join(fppd.media, "videos", "Short.mkv"), seconds=2)
    setup(fppd, [overlay_consumer()])
    fppd.start()
    play_to_end(fppd, "Short.mkv", "the first video to end")
    fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"] == 0, timeout=5,
                  what="the model to be handed back after the first video")
    log_at = len(fppd.log())
    play_to_end(fppd, "Short.mkv", "the second video to end")
    second = fppd.log()[log_at:]
    assert "(1 already built)" in second, \
        "the second video built its overlay member again:\n" + \
        "\n".join(l for l in second.splitlines() if "VideoOutputManager" in l)[-2000:]


def test_a_parked_overlay_member_leaves_the_model_alone(fppd, audio):
    """Between videos the member is parked, not gone: something else can
    use the model meanwhile (here a fill), and the parked member neither
    draws over it nor turns it off. After the hold it is torn down."""
    make_video(os.path.join(fppd.media, "videos", "Short.mkv"), seconds=2)
    setup(fppd, [overlay_consumer()])
    fppd.start()
    play_to_end(fppd, "Short.mkv")
    fppd.wait_for(lambda: fppd.get(f"/overlays/model/{MODEL}")["isActive"] == 0, timeout=5,
                  what="the model to be handed back")
    fppd.command("Overlay Model Fill", MODEL, "Enabled", "#FF0000")
    deadline = time.monotonic() + 2.5
    while time.monotonic() < deadline:
        state = fppd.get(f"/overlays/model/{MODEL}")["isActive"]
        px = pixels(fppd)[H // 2][W // 2]
        assert state and px == (255, 0, 0), f"the parked member touched the model: active={state} pixel={px}"
        time.sleep(0.1)
    fppd.wait_for(lambda: "Overlay: Vid' idle, tearing it down" in fppd.log(), timeout=10,
                  what="the parked member to be torn down after its hold")


def test_a_parked_rtp_member_stops_sending(fppd, audio):
    """An RTP member sends while the video plays and nothing once it ends,
    though it stays built for the next video."""
    port = free_udp_port()
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", port))
    rx.settimeout(0.2)
    try:
        make_video(os.path.join(fppd.media, "videos", "Short.mkv"), seconds=2)
        consumer = rtp_consumer(port, "mjpeg", source="")
        del consumer["sourceNode"]
        setup(fppd, [consumer])
        fppd.start()
        fppd.command("Play Media", "Short.mkv", "1", "0", "1", "HDMI-A-1")

        def received():
            try:
                return rx.recv(65536)
            except socket.timeout:
                return None
        fppd.wait_for(received, timeout=10, interval=0, what="RTP while the video plays")
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20,
                      interval=0.2, what="the video to end")
        time.sleep(0.5)
        while received():  # what was already on its way
            pass
        late = [p for p in (received() for _ in range(10)) if p]
        assert not late, f"{len(late)} RTP packets 2 s after the video ended"
    finally:
        rx.close()


def test_rtsp_port_warning_comes_down_once_the_port_is_free(fppd):
    """An RTSP output whose port is taken says so in a warning, and the
    warning comes down once the port is free and the outputs are reloaded.

    Regression: 48ed0c577. The "could not bind port" warning had no removal, so
    it stayed up until fppd restarted, contradicting a working stream.
    """
    import socket
    import tempfile
    if not fppd.built_with("rtsp-server"):
        pytest.skip("fppd was built without gst-rtsp-server: it has no RTSP output")
    port = 18554
    fppd.write("config/pipewire-rtsp-outputs.json", {"enabled": True, "port": port})
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "Cam", "sourceNode": "fppd_video_stream_1"}])
    held = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    held.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    held.bind(("0.0.0.0", port))
    held.listen(1)

    def flagged():
        return any(f"could not bind port {port}" in w
                   for w in fppd.get("/fppd/status").get("warnings", []))
    try:
        fppd.start()
        fppd.wait_for(flagged, timeout=20, what="the RTSP port warning")
    finally:
        held.close()
    path = tempfile.mktemp(prefix="fpp-test-client-", dir="/run/fppd")
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    try:
        s.bind(path)
        s.settimeout(15)
        s.sendto(b"reloadRTSPOutputs", "/run/fppd/FPPD")
        s.recv(4096)
    finally:
        s.close()
        os.unlink(path)
    fppd.wait_for(lambda: not flagged(), timeout=15, what="the RTSP port warning to come down")


def rgbw_model(name="Vid4"):
    """The same grid with four channels per node (RGBW)."""
    return {"Name": name, "Type": "Channel", "StartChannel": 1, "ChannelCount": W * H * 4,
            "ChannelCountPerNode": 4, "Orientation": "horizontal", "StartCorner": "TL",
            "StringCount": H, "StrandsPerString": 1}


def setup_rgbw(fppd, consumers, sources=None):
    setup(fppd, consumers, sources)
    fppd.write("config/co-universes.json", ddp_output(W * H * 4))
    fppd.write("config/model-overlays.json", {"autoCreate": False, "models": [rgbw_model()]})


def lit(fppd, name="Vid4"):
    data = fppd.get(f"/overlays/model/{name}/data").get("data") or []
    return sum(1 for v in data if v > 32)


def test_a_video_played_to_an_rgbw_model(fppd, audio):
    """Play Media of a video straight to an RGBW overlay model (four channels
    a pixel): the model lights up with the picture, and fppd survives.

    Regression: 35c41e967. The frame, packed RGB at the model's size, was
    pushed with setData(), which reads width x height x 4 bytes for an RGBW
    model: a third past the end of every frame, an ASan heap-buffer-overflow
    on the first one."""
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=4)
    setup_rgbw(fppd, [])
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "Vid4")
    fppd.wait_for(lambda: lit(fppd) > W * H, timeout=10, interval=0.2,
                  what="the RGBW model to show the video")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15,
                  interval=0.2, what="the video to end")


def test_a_video_group_feeds_an_rgbw_model(fppd, audio):
    """A video input source and an overlay member of a video group on an
    RGBW model: the model shows the source, and fppd survives.

    Regression: 35c41e967. The video group's overlay member pushed each
    frame with setData() too, reading a third past the end of it."""
    consumer = overlay_consumer(SOURCE)
    consumer["overlayModel"] = "Vid4"
    setup_rgbw(fppd, [consumer], [source("videotestsrc", pattern="smpte")])
    fppd.start()
    fppd.wait_for(lambda: lit(fppd) > W * H, timeout=15, interval=0.2,
                  what="the RGBW model to show the source")
    time.sleep(2)


def test_an_rtp_address_cannot_add_pipeline_elements(fppd, audio):
    """An RTP member whose address carries pipeline syntax is skipped and
    logged; the group's valid RTP member next to it still sends.

    Regression: de18312d4. The address was pasted after "udpsink host=" in
    the member's gst_parse_launch() description, so this one added a
    fakesrc feeding a filesink: an arbitrary file written as root from one
    saved config."""
    pwned = os.path.join(fppd.media, "tmp", "pwned")
    bad = rtp_consumer(free_udp_port(), "mjpeg", group=3)
    bad["address"] = (f"127.0.0.1 fakesrc num-buffers=1 ! filesink location={pwned} "
                      "fakesrc num-buffers=1 ! udpsink host=127.0.0.1")
    bad["name"] = "RTP: hostile"
    port = free_udp_port()
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", port))
    rx.settimeout(0.2)
    try:
        setup(fppd, [bad, rtp_consumer(port, "mjpeg")], [source("videotestsrc", pattern="smpte")])
        fppd.start()

        def received():
            try:
                return rx.recv(65536)
            except socket.timeout:
                return None
        fppd.wait_for(received, timeout=20, interval=0, what="RTP from the valid member")
    finally:
        rx.close()
    time.sleep(3)
    assert not os.path.exists(pwned), "the RTP address added a filesink to the member's pipeline"
    assert "has an invalid source or address" in fppd.log(), "the hostile member was not refused"


def ytdlp_stand_in(fppd, body):
    """A yt-dlp first on fppd's PATH running `body` (sh); its arguments are
    logged one per line to tmp/yt-dlp.args, each call ended by a line
    "@@". Returns fppd's extra_env."""
    bindir = os.path.join(fppd.media, "tmp", "bin")
    os.makedirs(bindir, exist_ok=True)
    log = os.path.join(fppd.media, "tmp", "yt-dlp.args")
    with open(os.path.join(bindir, "yt-dlp"), "w") as f:
        f.write(f'#!/bin/sh\nfor a in "$@"; do echo "$a" >> "{log}"; done\necho @@ >> "{log}"\n{body}\n')
    os.chmod(os.path.join(bindir, "yt-dlp"), 0o755)
    return {"PATH": bindir + ":" + os.environ["PATH"]}


def yt_dlp_calls(fppd):
    """Each yt-dlp call's arguments, as a list of lists."""
    try:
        with open(os.path.join(fppd.media, "tmp", "yt-dlp.args")) as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return []
    calls, cur = [], []
    for line in lines:
        if line == "@@":
            calls.append(cur)
            cur = []
        else:
            cur.append(line)
    return calls


def sleepers():
    """PIDs of the stand-in's `sleep 100`."""
    out = []
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                with open(f"/proc/{p}/cmdline", "rb") as f:
                    if f.read() == b"sleep\x00100\x00":
                        out.append(int(p))
            except OSError:
                pass
    return out


def test_a_hung_yt_dlp_holds_up_nothing(fppd, audio):
    """A YouTube video input whose yt-dlp lookup never answers: fppd still
    starts at once, a reload of the inputs answers, and fppd stops cleanly
    and promptly, taking the lookup with it.

    Regression: 6a958b852. Init() ran yt-dlp with no timeout under the input
    manager's lock before the API came up, so fppd didn't answer until the
    lookup returned (here 100 s)."""
    from test_command_socket import send
    import signal
    env = ytdlp_stand_in(fppd, "exec sleep 100")
    setup(fppd, [overlay_consumer(SOURCE)],
          [source("urisrc", uri="https://www.youtube.com/watch?v=x")])
    try:
        fppd.start(timeout=15, extra_env=env)
        fppd.wait_for(sleepers, timeout=10, what="the yt-dlp lookup to start")
        started = time.monotonic()
        send("reloadVideoInputs", timeout=5)
        took = time.monotonic() - started
        assert took < 2, f"reloadVideoInputs took {took:.1f} s to answer"
        fppd.get("/fppd/status", timeout=5)
        rc = fppd.stop(timeout=10)
        fppd.exit_expected = True
        assert rc == 0, f"fppd exited {rc}\n{fppd.tail()}"
        reports = fppd.sanitizer_reports()
        assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)
        deadline = time.monotonic() + 5
        while sleepers() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not sleepers(), "the yt-dlp lookup outlived fppd"
    finally:
        for pid in sleepers():
            os.kill(pid, signal.SIGKILL)


def test_a_video_input_uri_never_reaches_yt_dlp_as_an_option(fppd, audio):
    """A video input URI goes to yt-dlp only as an http(s) URL, after "--":
    one that reads as an option is refused before yt-dlp runs.

    Regression: 815c25c54. The URI was passed as a bare argument, and the
    filter in front of it keeps '-' and '=', so
    "--config-locations=.../youtube.com/x" had yt-dlp load a config file
    (which can carry --exec)."""
    env = ytdlp_stand_in(fppd, "exit 1")
    second = source("urisrc", uri="https://youtube.com/watch?v=y")
    second.update(id=2, name="Second", pipeWireNodeName="fpp_video_src_2_second")
    setup(fppd, [overlay_consumer(SOURCE)],
          [source("urisrc", uri="--config-locations=/tmp/youtube.com/x"), second])
    fppd.start(extra_env=env)
    fppd.wait_for(lambda: any("https://youtube.com/watch?v=y" in c for c in yt_dlp_calls(fppd)),
                  timeout=20, what="yt-dlp to be asked about the second source")
    time.sleep(1)
    calls = yt_dlp_calls(fppd)
    for c in calls:
        assert not any(a.startswith("--config") for a in c), f"yt-dlp was handed an option: {c}"
    for c in calls:
        url = c.index("https://youtube.com/watch?v=y") if "https://youtube.com/watch?v=y" in c else None
        if url is not None:
            assert url > 0 and c[url - 1] == "--", f"the URL does not follow --: {c}"


def hdmi_consumer(i, source=SOURCE, connector_id=None, card="/dev/dri/card0", group=10):
    c = {"groupId": group, "groupName": f"Wall {group}", "groupNodeName": f"fpp_video_group_{group}_wall",
         "type": "hdmi", "pipeWireNodeName": f"fpp_video_group_{group}_wall_m{i}_hdmi",
         "connector": "", "connectorId": connector_id or 1000 + i, "cardPath": card,
         "name": f"HDMI: {i}"}
    if source:
        c["sourceNode"] = source
    return c


def test_reloading_inputs_while_their_outputs_start(fppd, audio):
    """Reloading video inputs (the Video Input page's Apply) while a
    source's many display outputs are being started: every reload answers,
    and the input still serves its preview afterwards.

    Regression: 3c34e7137. Reload() joined the source's run thread holding
    the input manager's lock, while that thread, inside
    NotifyProducerReady() with the output manager's lock, waited on the
    input lock to read the frame rate for each output: a deadlock that
    stopped the main loop. 200 outputs make the window seconds long."""
    from test_command_socket import send
    consumers = [hdmi_consumer(i) for i in range(200)] + [overlay_consumer(SOURCE)]
    setup(fppd, consumers, [source("videotestsrc", pattern="smpte")])
    fppd.start()
    for i in range(40):
        try:
            send("reloadVideoInputs", timeout=5)
        except socket.timeout:
            raise AssertionError(f"reload {i + 1} got no answer within 5 s: fppd is wedged") from None
        time.sleep(0.1)

    def preview():
        try:
            with urllib.request.urlopen(f"{API}/videoinput/preview?id=1&width=64", timeout=10) as r:
                return r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError:
            return None
        except (TimeoutError, urllib.error.URLError) as e:
            raise AssertionError(f"the preview got no answer: {e}") from None
    ctype, jpeg = fppd.wait_for(preview, timeout=20, what="a preview of the input")
    assert ctype == "image/jpeg" and jpeg[:2] == b"\xff\xd8", (ctype, jpeg[:16])


def test_two_video_groups_on_one_display(fppd, audio):
    """Two enabled video groups that both list one display, and a video
    played to them: fppd drives the display from the first, says it skipped
    the second, and keeps running.

    Regression: 2d5482ba1. Both groups' entries got a direct kmssink branch,
    named after the connector, so the second's gst_bin_add() was refused,
    which freed the element, and the chain was then linked through it.
    Freed memory is scribbled over (ASan's free fill), so that link crashes
    rather than happening to work on the element's stale contents."""
    from fppd import sanitizer
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    setup(fppd, [overlay_consumer(),
                 hdmi_consumer(1, source=None, connector_id=77, card="", group=4),
                 hdmi_consumer(2, source=None, connector_id=77, card="", group=5)])
    env = {}
    if sanitizer(fppd.tree) == "asan":
        env["ASAN_OPTIONS"] = ("halt_on_error=1:detect_leaks=0:abort_on_error=0:"
                               f"log_path={fppd.media}/logs/asan:max_free_fill_size=65536:free_fill_byte=190")
    fppd.start(extra_env=env)
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", "HDMI-A-1")
    time.sleep(3)
    fppd.get("/fppd/status", timeout=5)
    assert "already driven by an earlier video output" in fppd.log(), \
        "the second group's entry for the display was not skipped"


def test_an_rtsp_stream_with_audio_at_startup(fppd, audio):
    """An RTSP output whose stream carries audio from a node nothing feeds:
    fppd starts, a reload of the RTSP outputs answers within seconds while
    the status keeps answering, and fppd stops cleanly.

    Regression: 305a89d01. The audio bridge was built before anything had
    initialised GStreamer (fppd crashed at startup, every boot), and its
    state change -- 30 s for a node nothing feeds -- ran on the main loop at
    startup and on every reload."""
    from test_command_socket import send
    import threading
    if not fppd.built_with("rtsp-server"):
        pytest.skip("fppd was built without gst-rtsp-server: it has no RTSP output")
    fppd.write("config/pipewire-rtsp-outputs.json",
               {"enabled": True, "port": 18555, "requireGroupSource": False})
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "Cam", "sourceNode": "fppd_video_stream_1", "videoEncoding": "mjpeg",
         "audioEnabled": True, "audioNodeName": "rtsp_cam_audio"}])
    fppd.settings(PipeWireVideoSinkName=SINK)
    fppd.start(timeout=60, extra_env={"GST_REGISTRY_1_0": os.path.join(fppd.media, "tmp", "fresh.bin")})
    slow = []
    done = threading.Event()

    def poll():
        while not done.is_set():
            t0 = time.monotonic()
            try:
                fppd.get("/rtspoutput", timeout=5)
            except Exception as e:
                slow.append(repr(e)[:200])
            if time.monotonic() - t0 > 2:
                slow.append(f"status took {time.monotonic() - t0:.1f} s")
            time.sleep(0.2)
    t = threading.Thread(target=poll)
    t.start()
    try:
        started = time.monotonic()
        try:
            send("reloadRTSPOutputs", timeout=30)
        except socket.timeout:
            raise AssertionError("reloadRTSPOutputs got no answer within 30 s") from None
        took = time.monotonic() - started
    finally:
        done.set()
        t.join()
    assert took < 10, f"reloadRTSPOutputs took {took:.1f} s"
    assert not slow, f"the RTSP status stalled during the reload: {slow[:5]}"
    rc = fppd.stop(timeout=10)
    fppd.exit_expected = True
    assert rc == 0, f"fppd exited {rc}\n{fppd.tail()}"
    reports = fppd.sanitizer_reports()
    assert not reports, "sanitizer report:\n" + "\n".join(r[:8000] for r in reports)


def test_an_overlay_member_stops_while_its_model_is_recreated(fppd, audio):
    """An overlay member of a video group on an output's own model (a
    ColorLight panel's): the outputs are saved again, which removes the
    model and creates it anew while the member draws on it, and then the
    video outputs are reloaded, which stops the member. Under TSan nothing
    is reported.

    Regression: be8334b52. StopConsumer() removed the model listener holding
    the member's state lock, and the listener runs under the overlay
    manager's models lock and takes that state lock: a lock-order inversion
    that could deadlock the two. TSan's deadlock detector reports it once
    both orders have run; ASan can't see it, so run with --flavor tsan."""
    from test_command_socket import send
    from test_overlays import PANEL_CHANNELS, colorlight_panel, resave_outputs
    consumer = overlay_consumer(SOURCE)
    consumer["overlayModel"] = "Panel"
    setup(fppd, [consumer], [source("videotestsrc", pattern="smpte")])
    fppd.write("config/channeloutputs.json", colorlight_panel())
    fppd.write("config/co-universes.json", ddp_output(PANEL_CHANNELS))
    fppd.write("config/model-overlays.json", {"autoCreate": True, "models": []})
    fppd.start()
    fppd.wait_for(lambda: lit(fppd, "Panel") > 32 * 16, timeout=20, interval=0.2,
                  what="the panel's model to show the source")
    resave_outputs(fppd)
    send("reloadVideoOutputs", timeout=10)
    time.sleep(1)


def input_preview(fppd, source_id=1):
    """The input's preview JPEG, or None while the source isn't running."""
    try:
        with urllib.request.urlopen(f"{API}/videoinput/preview?id={source_id}&width=64", timeout=10) as r:
            return r.read()
    except urllib.error.HTTPError:
        return None


def test_a_file_input_starts_again_after_it_ends(fppd, audio):
    """A video input source reading a 3 s file ends, and starts again after
    a 2 s backoff: its preview comes back and the model shows the bars
    again.

    Regression: 7d85c52d9. A source whose pipeline ended, errored or failed
    to start stayed dead until the config was saved or fppd restarted."""
    path = os.path.join(fppd.media, "videos", "Short.mkv")
    make_video(path, seconds=3)
    setup(fppd, [overlay_consumer(SOURCE)], [source("urisrc", uri="file://" + path)])
    fppd.start()
    wait_for_bars(fppd)
    fppd.wait_for(lambda: input_preview(fppd) is None, timeout=15, interval=0.2,
                  what="the source to end with its file")
    fppd.command("Overlay Model Clear", MODEL)
    fppd.wait_for(lambda: input_preview(fppd) is not None, timeout=10, interval=0.2,
                  what="the ended source to run again")
    wait_for_bars(fppd, timeout=10)
    assert "Restarting source 1 in 2000 ms" in fppd.log()


def test_an_unreachable_camera_is_retried_with_backoff(fppd, audio):
    """An RTSP video input whose camera hangs up at once is tried again
    after 2 s and then 4 s, and fppd stops cleanly while it waits out the
    next backoff. The "camera" counts the connections it gets.

    Regression: 7d85c52d9. The source failed once and was never tried
    again."""
    import threading
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", 0))
    server.listen(16)
    server.settimeout(0.2)
    port = server.getsockname()[1]
    connections = []
    done = threading.Event()

    def hang_up():
        while not done.is_set():
            try:
                c, _ = server.accept()
            except (socket.timeout, OSError):
                continue
            connections.append(time.monotonic())
            c.close()
    t = threading.Thread(target=hang_up, daemon=True)
    t.start()
    try:
        setup(fppd, [overlay_consumer(SOURCE)], [source("rtspsrc", uri=f"rtsp://127.0.0.1:{port}/x")])
        fppd.start()

        def attempts():
            # One start can connect more than once; starts are seconds apart.
            starts = []
            for c in connections:
                if not starts or c - starts[-1][-1] > 1.0:
                    starts.append([c])
                else:
                    starts[-1].append(c)
            return [s[0] for s in starts]
        fppd.wait_for(lambda: len(attempts()) >= 3, timeout=25, interval=0.25,
                      what=f"three connection attempts (got {len(attempts())})")
        a = attempts()
        gaps = [round(b - x, 1) for x, b in zip(a, a[1:])]
        assert 1.0 <= gaps[0] <= 4.0 and 2.5 <= gaps[1] <= 7.0, f"retries {gaps} s apart, expected about 2 then 4"
    finally:
        done.set()
        t.join()
        server.close()


def test_a_youtube_input_whose_first_lookup_fails_is_retried(fppd, audio):
    """A YouTube video input whose first yt-dlp lookups fail (no network
    yet at boot) is tried again, and once yt-dlp answers with a stream URL
    the model shows it.

    Regression: 4aaae514e. StartLoadedSources() ignored StartSource()'s
    result, and only a source that had started before was rescheduled, so
    a lookup that failed at startup left the input dark until Apply."""
    import functools
    import http.server
    import threading
    served = os.path.join(fppd.media, "tmp", "www")
    os.makedirs(served)
    make_video(os.path.join(served, "Bars.mkv"), seconds=30)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=served)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    count = os.path.join(fppd.media, "tmp", "yt-dlp.count")
    url = f"http://127.0.0.1:{server.server_address[1]}/Bars.mkv"
    try:
        # The first two lookups fail: startup sometimes loads the sources
        # twice, and a second lookup there would hide the missing retry.
        env = ytdlp_stand_in(fppd, f'echo x >> "{count}"\n'
                                   f'if [ "$(wc -l < "{count}")" -le 2 ]; then exit 1; fi\n'
                                   f'echo "{url}"\necho 10')
        setup(fppd, [overlay_consumer(SOURCE)],
              [source("urisrc", uri="https://www.youtube.com/watch?v=x")])
        fppd.start(extra_env=env)
        wait_for_bars(fppd, timeout=30)
    finally:
        server.shutdown()

def test_an_overlay_member_that_failed_to_start_is_retried(fppd, audio):
    """An overlay member of a video group whose pipeline fails to build the
    first time (a shim makes the first gst_parse_launch() of it fail) is
    tried again, and the model shows the source.

    Regression: 48eac2e56. A persistent member is started once, when its
    source reaches PLAYING; one that failed then stayed dark until the
    source restarted or the config was saved."""
    import shims
    setup(fppd, [overlay_consumer(SOURCE)], [source("videotestsrc", pattern="smpte")])
    fppd.start(preload=[shims.build("failparse.c")])
    wait_for_bars(fppd, timeout=15)


def test_an_rtsp_stream_of_a_playback_slot_shows_the_video(fppd, audio):
    """An RTSP stream aimed at playback slot 1 serves the video that plays
    there: a client pulling it gets the bars, not a flat frame.

    Regression: 3c3784f46. Playback never published its video on the slot's
    channel, so an RTSP stream of a slot served black (luma 16, variance 0)."""
    import statistics
    if not fppd.built_with("rtsp-server"):
        pytest.skip("fppd was built without gst-rtsp-server: it has no RTSP output")
    make_video(os.path.join(fppd.media, "videos", "Bars.mkv"), seconds=30)
    setup(fppd, [])
    fppd.write("config/pipewire-rtsp-outputs.json", {"enabled": True, "port": 18554})
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "Slot", "streamSlots": [1], "videoEncoding": "mjpeg",
         "mountPoint": "/slot"}])
    fppd.start()
    fppd.command("Play Media", "Bars.mkv", "1", "0", "1", "HDMI-A-1")
    time.sleep(2)
    size = W * H * 3
    client = subprocess.Popen(
        ["gst-launch-1.0", "-q", "rtspsrc", "location=rtsp://127.0.0.1:18554/slot", "protocols=tcp",
         "!", "rtpjpegdepay", "!", "jpegdec", "!", "videoconvert", "!", "videoscale", "!",
         f"video/x-raw,format=RGB,width={W},height={H}", "!", "fdsink", "fd=1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frames = []
    try:
        import select
        buf = b""
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and len(frames) < 20:
            r, _, _ = select.select([client.stdout], [], [], 0.5)
            if r:
                chunk = os.read(client.stdout.fileno(), 65536)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= size:
                    frames.append(buf[:size])
                    buf = buf[size:]
    finally:
        client.kill()
        client.wait()
    assert frames, "the RTSP client got no frames"
    lumas = [[(px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) // 1000 for i in range(0, size, 3)]
             for px in frames]
    spread = max(statistics.pvariance(l) for l in lumas)
    assert spread > 500, \
        f"the stream is flat: mean luma {[round(statistics.fmean(l)) for l in lumas][:5]}, variance at most {spread:.0f}"


def fake_kms_env(fppd, **extra):
    """fppd's environment for a stand-in kmssink (fakekms.c) in place of
    the real one, which can't open a display here: GStreamer's plugin path
    is every system plugin but libgstkms.so, plus the stand-in, with a
    registry of its own. What the sinks do is logged to tmp/fakekms.log
    (kms_events())."""
    import glob
    import shims
    core = glob.glob("/usr/lib/*/gstreamer-1.0/libgstcoreelements.so")
    if not core:
        pytest.skip("GStreamer's system plugin directory was not found")
    flags = subprocess.run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0", "gstreamer-base-1.0"],
                           capture_output=True, text=True)
    if flags.returncode:
        pytest.skip("the GStreamer development files are not installed")
    so = shims.build("fakekms.c", libs=("-ldl", *flags.stdout.split()))
    farm = os.path.join(fppd.media, "tmp", "gst-plugins")
    os.makedirs(farm)
    system = os.path.dirname(core[0])
    for name in os.listdir(system):
        if name.endswith(".so") and name != "libgstkms.so":
            os.symlink(os.path.join(system, name), os.path.join(farm, name))
    os.symlink(so, os.path.join(farm, "libgstfakekms.so"))
    env = {"GST_PLUGIN_SYSTEM_PATH_1_0": farm,
           "GST_REGISTRY_1_0": os.path.join(fppd.media, "tmp", "gst-registry.bin"),
           "FAKEKMS_LOG": os.path.join(fppd.media, "tmp", "fakekms.log")}
    env.update({k: str(v) for k, v in extra.items()})
    return env


def kms_events(fppd):
    """[(event, element, connector id, monotonic s)] from the stand-in kmssink."""
    try:
        with open(os.path.join(fppd.media, "tmp", "fakekms.log")) as f:
            return [(e, n, int(c), float(t)) for e, n, c, t in (l.split() for l in f if l.strip())]
    except FileNotFoundError:
        return []


def test_a_failing_secondary_display_does_not_stop_the_video(fppd, audio):
    """A video played to a group with an overlay member and an HDMI member
    whose display fails 1 s in (the stand-in kmssink errors after 10
    frames): the overlay member keeps showing the video, and playback goes
    on to the end of the file.

    Regression: 7420a08ad. The sink's flow error went back up through the
    video tee to the demuxer, which posted "Internal data stream error", and
    the whole video stopped about a second in."""
    make_video(os.path.join(fppd.media, "videos", "Six.mkv"), seconds=6)
    setup(fppd, [overlay_consumer(), hdmi_consumer(1, source=None, connector_id=77, card="", group=4)])
    fppd.start(extra_env=fake_kms_env(fppd, FAKEKMS_FAIL_AFTER=10))
    started = time.monotonic()
    fppd.command("Play Media", "Six.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: any(e == "frame" and n == "dkms_77" for e, n, _, _ in kms_events(fppd)),
                  timeout=10, what="the HDMI member's first frame (precondition: the stand-in sink runs)")
    time.sleep(max(0.0, 3 - (time.monotonic() - started)))
    fppd.command("Overlay Model Clear", MODEL)
    wait_for_bars(fppd, timeout=3)
    time.sleep(max(0.0, 4.5 - (time.monotonic() - started)))
    s = status(fppd)
    assert s.get("status_name") != "idle", "the video stopped when the HDMI member failed"
    assert "cut its branch off" in fppd.log()


def test_an_audio_file_with_an_hdmi_member_plays_through(fppd, audio):
    """An audio-only file played with HDMI as the video output, to a group
    that has an HDMI member: the sound plays to its end and the player goes
    idle on time.

    Regression: 593fc1d80. The HDMI member's direct kmssink branch was
    built for the file anyway; with no video to feed it, it never prerolled,
    the pipeline sat in PAUSED, and nothing played or ended."""
    from audio import write_tone_wav
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 2, freq=1000, amplitude=0.5)
    setup(fppd, [hdmi_consumer(1, source=None, connector_id=77, card="", group=4)])
    fppd.start(extra_env=fake_kms_env(fppd))
    rec = audio.record()
    started = time.monotonic()
    fppd.command("Play Media", "Tone.wav", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10, interval=0.1,
                  what="the player to go idle after the file")
    took = time.monotonic() - started
    time.sleep(0.3)
    samples = rec.stop()
    loud = [i for i, x in enumerate(samples) if abs(x) > 0.1]
    heard = (loud[-1] - loud[0]) / 48000 if loud else 0
    assert heard >= 1.6, f"heard {heard:.2f} s of a 2 s file"
    assert took <= 4, f"a 2 s file took {took:.1f} s to end"


def test_a_camera_group_stands_aside_for_a_video_and_comes_back(fppd, audio):
    """A camera group (an HDMI member showing a live source) on the display
    a video also plays to: the camera's sink stops when the video starts,
    shows nothing while it plays, and starts again once it has ended.

    Regression: d0e7281e0. Nothing called SuspendPersistentHdmiConsumers(),
    so the camera kept rendering to the display underneath the video."""
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    # A card that doesn't exist: no lease, but a card path is what makes
    # playback claim the display from the camera.
    camera = hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)
    setup(fppd, [camera, hdmi_consumer(2, source=None, connector_id=77, card="/dev/dri/card9", group=4)],
          [source("videotestsrc", pattern="smpte")])
    fppd.start(extra_env=fake_kms_env(fppd))

    def camera_events(kind):
        return [t for e, n, c, t in kms_events(fppd) if e == kind and n == "sink" and c == 77]
    fppd.wait_for(lambda: camera_events("frame"), timeout=20, what="the camera's first frame")
    asked = time.monotonic()
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: [t for t in camera_events("stop") if t >= asked - 0.2], timeout=3,
                  interval=0.05, what="the camera's sink to stop for the video")
    stopped = max(camera_events("stop"))
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.1,
                  what="the video to end")
    ended = time.monotonic()
    fppd.wait_for(lambda: [t for t in camera_events("start") if t > stopped], timeout=8,
                  interval=0.1, what="the camera to start again after the video")
    during = [t for t in camera_events("frame") if stopped < t < ended - 0.5]
    assert not during, f"the camera showed {len(during)} frames under the video"


def test_a_camera_group_whose_comeback_fails_is_retried(fppd, audio):
    """A camera group that stood aside for a video, and whose first
    comeback after it fails (a shim makes that one pipeline fail to build,
    as a display still off or a parse failure does): it is tried again and
    the camera comes back.

    Regression: d51eaa14d. StartConsumer() returned before clearing
    suspendedForMedia, and the retry loop skips a consumer with that flag
    set, so with no media claim left to clear it the camera stayed dark
    until Apply."""
    import shims
    make_video(os.path.join(fppd.media, "videos", "Four.mkv"), seconds=4)
    camera = hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)
    setup(fppd, [camera, hdmi_consumer(2, source=None, connector_id=77, card="/dev/dri/card9", group=4)],
          [source("videotestsrc", pattern="smpte")])
    # The camera's kmssink is "kmssink name=sink"; let its first start
    # through and fail the next one, the comeback.
    fppd.start(preload=[shims.build("failparse.c")],
               extra_env=fake_kms_env(fppd, FAILPARSE_MATCH="kmssink name=sink", FAILPARSE_SKIP=1))

    def camera_events(kind):
        return [t for e, n, c, t in kms_events(fppd) if e == kind and n == "sink" and c == 77]
    fppd.wait_for(lambda: camera_events("frame"), timeout=20, what="the camera's first frame")
    fppd.command("Play Media", "Four.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: camera_events("stop"), timeout=3, interval=0.05,
                  what="the camera's sink to stop for the video (precondition)")
    stopped = max(camera_events("stop"))
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.1,
                  what="the video to end")
    fppd.wait_for(lambda: [t for t in camera_events("start") if t > stopped], timeout=20,
                  interval=0.2, what="the camera to come back after its failed comeback")

def test_every_kmssink_skips_vsync(fppd, audio):
    """Every kmssink fppd builds -- a camera group's persistent one and a
    video's -- is started with skip-vsync, so none of them waits for a
    page-flip event on its DRM fd.

    Regression: 081ff8d9e. The camera group's kmssink was built without it.
    When its connector can't be leased (a restart while the old pipeline
    still holds it) it gets the card's shared fd, whose events the
    framebuffer outputs drain: it stalled 3 s on an event they took, or ran
    its handler on one of theirs (SIGSEGV). Only the flag is checked here;
    the crossing needs a real card.
    """
    make_video(os.path.join(fppd.media, "videos", "Two.mkv"), seconds=2)
    camera = hdmi_consumer(1, connector_id=77, card="/dev/dri/card9", group=3)
    setup(fppd, [camera, hdmi_consumer(2, source=None, connector_id=77, card="/dev/dri/card9", group=4)],
          [source("videotestsrc", pattern="smpte")])
    fppd.start(extra_env=fake_kms_env(fppd))
    fppd.wait_for(lambda: [e for e in kms_events(fppd) if e[0] == "frame" and e[2] == 77],
                  timeout=20, what="the camera's first frame")
    fppd.command("Play Media", "Two.mkv", "1", "0", "1", "HDMI-A-1")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.1,
                  what="the video to end")
    events = kms_events(fppd)
    starts = [e for e in events if e[0] == "start"]
    waiting = [e for e in events if e[0] == "waitvsync"]
    assert len(starts) >= 2, f"expected the camera's and the video's sinks to start: {events}"
    assert not waiting, f"kmssinks started without skip-vsync: {waiting}"
