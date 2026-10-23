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


def link_as_it_appears(node):
    """Link `node` from the test sink's monitor the moment it appears, as an
    audio group targeting it does on a device. Returns a list that gets the
    time of the link."""
    import threading
    linked = []

    def spin():
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if link_monitor_to(node):
                linked.append(time.monotonic())
                return
            time.sleep(0.005)
    threading.Thread(target=spin, daemon=True).start()
    return linked


class Viewer:
    """One RTSP viewer on a TCP connection of its own, speaking just enough
    RTSP to hold a session: requests are answered in order, and RTP/RTCP
    the server interleaves on the connection is counted and skipped."""

    def __init__(self, port, timeout=60):
        self.port = port
        self.timeout = timeout
        self.s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.buf = b""
        self.cseq = 0
        self.rtp = 0          # interleaved packets received on channel 0
        self.session = None

    def _frame(self):
        """Take one complete interleaved frame or response off the buffer:
        ("rtp", None), ("response", (status, headers)), or None for more."""
        if self.buf.startswith(b"$"):
            if len(self.buf) < 4:
                return None
            n = int.from_bytes(self.buf[2:4], "big")
            if len(self.buf) < 4 + n:
                return None
            if self.buf[1] == 0:
                self.rtp += 1
            self.buf = self.buf[4 + n:]
            return ("rtp", None)
        head, sep, rest = self.buf.partition(b"\r\n\r\n")
        if not sep:
            return None
        lines = head.decode(errors="replace").split("\r\n")
        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        n = int(headers.get("content-length", "0"))
        if len(rest) < n:
            return None
        self.buf = rest[n:]
        return ("response", (int(lines[0].split()[1]), headers))

    def request(self, method, url, *headers, session=True):
        """Send a request and return (status, headers) of its answer."""
        self.cseq += 1
        lines = [f"{method} {url} RTSP/1.0", f"CSeq: {self.cseq}", *headers]
        if session and self.session:
            lines.append(f"Session: {self.session}")
        self.s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        deadline = time.monotonic() + self.timeout
        while True:
            got = self._frame()
            if got and got[0] == "response":
                status, h = got[1]
                if method == "SETUP" and status == 200:
                    self.session = h["session"].split(";")[0]
                return status, h
            if got is None:
                left = deadline - time.monotonic()
                assert left > 0, f"no answer to {method} within {self.timeout}s"
                self.s.settimeout(left)
                chunk = self.s.recv(65536)
                assert chunk, f"the server closed the connection instead of answering {method}"
                self.buf += chunk

    def setup(self, url, transport="RTP/AVP/TCP;unicast;interleaved=0-1"):
        return self.request("SETUP", url, f"Transport: {transport}")[0]

    def drain(self):
        """Read whatever has arrived, without waiting."""
        while select.select([self.s], [], [], 0)[0]:
            chunk = self.s.recv(65536)
            if not chunk:
                return
            self.buf += chunk
            while self._frame():
                pass

    def closed_within(self, timeout):
        """True once the server closes this connection (EOF or a reset),
        reading and skipping whatever it sends until then; False if it is
        still open after `timeout` seconds."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            if not select.select([self.s], [], [], min(left, 1))[0]:
                continue
            try:
                chunk = self.s.recv(65536)
            except (ConnectionResetError, BrokenPipeError):
                return True
            if not chunk:
                return True
            self.buf += chunk
            while self._frame():
                pass

    def vanish(self):
        """Go away as a killed app does: no TEARDOWN, the connection reset."""
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.s.close()

    def close(self):
        self.s.close()


def udp_port_pair():
    """Two bound UDP sockets on an even port and the one after it, the
    client_port pair a UDP viewer offers in its SETUP."""
    while True:
        rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rtp.bind(("127.0.0.1", 0))
        p = rtp.getsockname()[1]
        if p % 2 == 0 and p < 65535:
            rtcp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                rtcp.bind(("127.0.0.1", p + 1))
                return rtp, rtcp
            except OSError:
                rtcp.close()
        rtp.close()


def serve_one_mount(fppd, port, mount):
    """An RTSP server with one small MJPEG mount; returns the URL to SETUP
    its video stream on, once a DESCRIBE answers with the stream."""
    fppd.write("config/pipewire-rtsp-outputs.json", {"enabled": True, "port": port})
    fppd.write("config/pipewire-video-consumers.json", [
        {"type": "rtsp", "name": "Viewers", "streamSlots": [1], "videoEncoding": "mjpeg", "mountPoint": mount,
         "width": 160, "height": 120, "framerate": 5}])
    fppd.settings(PipeWireVideoSinkName=SINK, LogLevel_MediaOut="info")
    fppd.start()
    head, sdp = fppd.wait_for(lambda: (lambda r: r if "m=video" in r[1] else None)(describe(port, mount)),
                              timeout=60, interval=0.5, what="an SDP from the RTSP server")
    control = [l.split(":", 1)[1].strip() for l in sdp.splitlines() if l.startswith("a=control:")]
    track = next(c for c in control if c != "*")
    return track if track.startswith("rtsp://") else f"rtsp://127.0.0.1:{port}{mount}/{track}"


@pytest.mark.parametrize("linked_early", [False, True], ids=["linked-after-start", "linked-as-it-appears"])
def test_an_rtsp_stream_carries_the_audio_fed_to_its_node(fppd, audio, linked_early):
    """An RTSP stream of playback slot 1 with audio on: its SDP offers an
    Opus audio track next to the video, and with a tone playing into the
    stream's audio node a client pulling the stream hears it -- also when
    the node is linked the moment it appears, while its bridge is starting.

    Feature: f42b7c003 (an RTSP video output that carries audio).
    Regression: 5a98f1b0b. The bridge ran on pipewiresrc's GstPipeWireClock,
    which stops advancing for a follower stream once the graph's real driver
    takes it over. Linked while starting, it passed a buffer or two and then
    waited on that clock forever: clients heard silence."""
    needs_rtsp(fppd)
    port, node = 18557, "fpp_rtsp_av"
    if linked_early:
        link_as_it_appears(node)
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


def test_rtsp_sessions_are_capped_at_32(fppd):
    """36 viewers each SETUP the stream on a connection of their own, all
    kept open: the first 32 get a session (200 and a Session header) and
    the other 4 are refused with 503 Service Unavailable. When one viewer
    TEARs DOWN, its slot is free again: the next new viewer gets a session,
    and the one after it is refused.

    Regression: ce8805157. There was no limit on how many sessions could be
    open at once, so all 36 got one."""
    needs_rtsp(fppd)
    port = 18559
    url = serve_one_mount(fppd, port, "/cap")
    viewers = []
    try:
        codes = []
        for _ in range(36):
            viewers.append(Viewer(port))
            codes.append(viewers[-1].setup(url))
        assert codes == [200] * 32 + [503] * 4, f"SETUP answers, in order: {codes}"
        assert len({v.session for v in viewers[:32]}) == 32, [v.session for v in viewers[:32]]

        status, _ = viewers[0].request("TEARDOWN", url.rsplit("/", 1)[0])
        assert status == 200, f"TEARDOWN answered {status}"
        more = [Viewer(port), Viewer(port)]
        viewers += more
        codes = [v.setup(url) for v in more]
        assert codes == [200, 503], f"SETUP answers after one TEARDOWN: {codes}"
    finally:
        for v in viewers:
            v.close()


def test_an_rtsp_session_whose_viewer_vanished_expires(fppd):
    """A viewer that SETs UP and PLAYs over UDP and then vanishes without a
    TEARDOWN (its connection reset and its ports closed, as when the app is
    killed) has its session expired by the server about 65s later (the 60s
    session timeout and gst-rtsp-server's 5s grace, plus the 2s cleanup
    tick): fppd logs that it expired one session, and the vanished session
    is then unknown (454). Another viewer, on TCP and kept alive with
    GET_PARAMETER as players do, keeps its session and its stream.

    Regression: ce8805157. Nothing ever ran the session pool's cleanup, so
    a vanished viewer's session stayed for the life of the server."""
    needs_rtsp(fppd)
    port = 18560
    url = serve_one_mount(fppd, port, "/expire")
    base = url.rsplit("/", 1)[0]
    rtp, rtcp = udp_port_pair()
    p = rtp.getsockname()[1]
    live, dead = Viewer(port), Viewer(port)
    try:
        assert live.setup(url) == 200
        assert live.request("PLAY", base, "Range: npt=0-")[0] == 200
        assert dead.setup(url, f"RTP/AVP;unicast;client_port={p}-{p + 1}") == 200
        assert dead.request("PLAY", base, "Range: npt=0-")[0] == 200
        rtp.settimeout(30)
        assert rtp.recv(65536), "the UDP viewer got no RTP"
        fppd.wait_for(lambda: live.drain() or live.rtp > 0, timeout=30, interval=0.2,
                      what="RTP on the TCP viewer's connection")

        gone = dead.session
        dead.vanish()
        rtp.close()
        rtcp.close()
        vanished = time.monotonic()
        expired = "RTSPOutputManager: expired"
        last_keepalive = vanished
        while expired not in fppd.log() and time.monotonic() - vanished < 180:
            fppd.check_alive()
            live.drain()
            if time.monotonic() - last_keepalive > 10:
                assert live.request("GET_PARAMETER", base)[0] == 200, "the TCP viewer's keepalive failed"
                last_keepalive = time.monotonic()
            time.sleep(0.2)
        elapsed = time.monotonic() - vanished
        probe = Viewer(port)
        try:
            probe.session = gone
            status = probe.request("GET_PARAMETER", base)[0]
        finally:
            probe.close()
        assert status == 454, \
            f"the vanished viewer's session is still there {elapsed:.0f}s after it went away (answered {status})"
        assert elapsed > 50, f"the session expired {elapsed:.0f}s after its viewer went away, before its timeout"
        lines = [l for l in fppd.log().splitlines() if expired in l]
        assert len(lines) == 1 and "expired 1 session(s) whose client went away" in lines[0], lines

        assert live.request("GET_PARAMETER", base)[0] == 200, "the TCP viewer lost its session"
        before = live.rtp
        fppd.wait_for(lambda: live.drain() or live.rtp > before, timeout=30, interval=0.2,
                      what="RTP still reaching the TCP viewer after the expiry")
    finally:
        live.close()
        dead.close()
        rtp.close()
        rtcp.close()


@pytest.mark.parametrize("disabled", [False, True], ids=["reloaded", "disabled"])
def test_rtsp_viewers_are_disconnected_when_the_server_stops(fppd, disabled):
    """Two viewers are connected to the RTSP server: one has SET UP and is
    PLAYing the stream over TCP (RTP is reaching it), the other has only
    asked for OPTIONS. Then the RTSP outputs are reloaded
    (reloadRTSPOutputs, as the UI sends when the config is saved), with the
    config unchanged or with the output disabled. That stops the server,
    and the server closes both viewers' connections within 30s. Reloaded,
    the restarted server serves a new viewer the stream; disabled, nothing
    accepts a connection on the port any more.

    Regression: 95150b12b. Stopping the server quit its loop and dropped it
    but left its clients and sessions alone: both viewers stayed connected
    after the reload, the playing one still getting the old stream's RTP
    and the idle one still answered, by a server that was meant to be gone.
    (The checks after the disconnects passed before the fix too; they are
    there so that closing the clients is not paid for with a server that
    fails to restart or to let go of its port.)"""
    from test_command_socket import send
    needs_rtsp(fppd)
    port = 18561
    url = serve_one_mount(fppd, port, "/stop")
    base = url.rsplit("/", 1)[0]
    playing, idle = Viewer(port), Viewer(port)
    try:
        assert playing.setup(url) == 200
        assert playing.request("PLAY", base, "Range: npt=0-")[0] == 200
        fppd.wait_for(lambda: playing.drain() or playing.rtp > 0, timeout=30, interval=0.2,
                      what="RTP on the playing viewer's connection")
        assert idle.request("OPTIONS", base, session=False)[0] == 200

        if disabled:
            fppd.write("config/pipewire-rtsp-outputs.json", {"enabled": False, "port": port})
        reply = send("reloadRTSPOutputs", timeout=30)
        assert "RTSP outputs reloaded" in reply, reply
        before = playing.rtp
        assert playing.closed_within(30), \
            ("the playing viewer is still connected 30s after the RTSP server stopped "
             f"({playing.rtp - before} RTP packets reached it after the reload)")
        assert idle.closed_within(30), \
            "the idle viewer is still connected 30s after the RTSP server stopped"
    finally:
        playing.close()
        idle.close()

    if disabled:
        assert fppd.get("/rtspoutput")["active"] is False
        with pytest.raises(ConnectionRefusedError):
            socket.create_connection(("127.0.0.1", port), timeout=10).close()
        return
    def offered():
        try:
            return "m=video" in describe(port, "/stop")[1]
        except OSError:
            return False
    fppd.wait_for(offered, timeout=60, interval=0.5, what="an SDP from the restarted RTSP server")
    fresh = Viewer(port)
    try:
        assert fresh.setup(url) == 200
        assert fresh.request("PLAY", base, "Range: npt=0-")[0] == 200
        fppd.wait_for(lambda: fresh.drain() or fresh.rtp > 0, timeout=30, interval=0.2,
                      what="RTP from the restarted RTSP server")
    finally:
        fresh.close()
