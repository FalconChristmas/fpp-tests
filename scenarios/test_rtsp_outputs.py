"""RTSP outputs (RTSPOutputManager): what a client connecting to fppd's
RTSP server is offered and gets. Skipped where fppd was built without
gst-rtsp-server."""

import os
import select
import socket
import struct
import subprocess
import time

import pytest

from audio import env as audio_env, write_tone_wav
from test_video import SINK


def needs_rtsp(fppd):
    if not fppd.built_with("rtsp-server"):
        pytest.skip("fppd was built without gst-rtsp-server: it has no RTSP output")


def describe(port, path):
    """The SDP fppd's RTSP server answers DESCRIBE with."""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(f"DESCRIBE rtsp://127.0.0.1:{port}{path} RTSP/1.0\r\nCSeq: 1\r\n"
                  "Accept: application/sdp\r\n\r\n".encode())
        data = b""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            head, sep, body = data.partition(b"\r\n\r\n")
            if sep:
                n = 0
                for line in head.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        n = int(line.split(b":")[1])
                if len(body) >= n:
                    return head.decode(errors="replace"), body[:n].decode(errors="replace")
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    return data.decode(errors="replace"), ""


def link_monitor_to(node):
    """Feed `node` from the test sink's monitor, as an audio group routed
    into it would. True once both channels are linked."""
    ok = True
    for ch in ("FL", "FR"):
        r = subprocess.run(["pw-link", f"fpp_test_sink:monitor_{ch}", f"{node}:input_{ch}"],
                           env=audio_env(), capture_output=True, text=True)
        ok = ok and (r.returncode == 0 or "exists" in r.stderr)
    return ok


def test_an_rtsp_stream_carries_the_audio_fed_to_its_node(fppd, audio):
    """An RTSP stream of playback slot 1 with audio on: its SDP offers an
    Opus audio track next to the video, and with a tone playing into the
    stream's audio node a client pulling the stream hears it.

    Feature: f42b7c003 (an RTSP video output that carries audio)."""
    needs_rtsp(fppd)
    port, node = 18557, "fpp_rtsp_av"
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 30, freq=1000, amplitude=0.5)
    fppd.write("config/pipewire-rtsp-outputs.json",
               {"enabled": True, "port": port, "requireGroupSource": False})
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "AV", "streamSlots": [1], "videoEncoding": "mjpeg", "mountPoint": "/av",
         "width": 160, "height": 120, "framerate": 10, "audioEnabled": True, "audioNodeName": node}])
    fppd.settings(PipeWireVideoSinkName=SINK)
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", "1")
    fppd.wait_for(lambda: link_monitor_to(node), timeout=20, interval=0.5,
                  what=f"the RTSP audio node {node} to take a link")

    head, sdp = fppd.wait_for(lambda: (lambda r: r if "m=" in r[1] else None)(describe(port, "/av")),
                              timeout=20, interval=0.5, what="an SDP from the RTSP server")
    media = [l for l in sdp.splitlines() if l.startswith("m=")]
    assert any(l.startswith("m=video") for l in media), sdp
    assert any(l.startswith("m=audio") for l in media), f"no audio track offered:\n{sdp}"
    assert "OPUS/48000" in sdp.upper(), sdp

    client = subprocess.Popen(
        ["gst-launch-1.0", "-q", "rtspsrc", f"location=rtsp://127.0.0.1:{port}/av", "protocols=tcp",
         "name=s", "s.", "!", "application/x-rtp,media=audio", "!", "rtpopusdepay", "!", "opusdec",
         "!", "audioconvert", "!", "audioresample", "!",
         "audio/x-raw,format=S16LE,channels=1,rate=48000", "!", "fdsink", "fd=1",
         "s.", "!", "application/x-rtp,media=video", "!", "fakesink"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    pcm = b""
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and len(pcm) < 48000 * 2 * 6:
            r, _, _ = select.select([client.stdout], [], [], 0.5)
            if r:
                chunk = os.read(client.stdout.fileno(), 65536)
                if not chunk:
                    break
                pcm += chunk
    finally:
        client.kill()
        client.wait()
    samples = struct.unpack(f"<{len(pcm) // 2}h", pcm[:len(pcm) // 2 * 2])
    assert len(samples) > 48000, f"the client decoded only {len(samples)} audio samples"
    loud = sum(1 for x in samples if abs(x) > 3000)
    assert loud > len(samples) // 10, \
        f"{loud} loud samples of {len(samples)}: the stream's audio is silent"


@pytest.mark.parametrize("configured,expected,warned", [(None, 40, False), (120, 120, False),
                                                        (9999, 40, True), (-5, 40, True)],
                         ids=["default", "set", "too high", "negative"])
def test_rtsp_latency_is_reported_and_kept_in_range(fppd, configured, expected, warned):
    """The RTSP server's per-media latency (latencyMs) is 40 ms unless set,
    is kept when it is 0-5000, and an out-of-range value falls back to 40
    with a warning in the log; /rtspoutput reports what is in use.

    Feature: 8b6f17e57. gst-rtsp-server's own default is 200 ms of
    buffering in each media, which a viewer feels as lag."""
    needs_rtsp(fppd)
    cfg = {"enabled": True, "port": 18558}
    if configured is not None:
        cfg["latencyMs"] = configured
    fppd.write("config/pipewire-rtsp-outputs.json", cfg)
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "Slot", "streamSlots": [1], "videoEncoding": "mjpeg", "mountPoint": "/slot"}])
    fppd.settings(PipeWireVideoSinkName=SINK)
    fppd.start()
    st = fppd.wait_for(lambda: (lambda r: r if isinstance(r, dict) and "latencyMs" in r else None)(
        fppd.get("/rtspoutput")), timeout=15, what="/rtspoutput to report latencyMs")
    assert st["latencyMs"] == expected, st
    assert ("latencyMs %d out of range" % configured in fppd.log() if warned else True), fppd.log()[-2000:]
