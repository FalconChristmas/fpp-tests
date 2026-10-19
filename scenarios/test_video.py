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
    plays, and the model is left as it was when the video ends."""
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
