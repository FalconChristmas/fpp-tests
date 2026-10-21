"""A stand-in RTSP camera: answers OPTIONS and DESCRIBE with the SDP a
scenario chooses, records each SETUP, and on PLAY streams the tracks that
were set up, interleaved on the RTSP connection (protocols=tcp, as fppd's
rtspsrc asks for).

Each track is {"media": "video" | "audio", "codec": ...}:
  video JPEG -- videotestsrc's SMPTE bars, 320x240 at 10 fps (payload 26);
  video H264 -- advertised only, nothing is ever sent (there is no encoder);
  audio PCMU -- a 1 kHz tone at 8 kHz (payload 0).
The media are produced by gst-launch-1.0 into a local UDP port and copied
onto the connection as $-framed packets on the setup's interleaved channel.
"""

import re
import socket
import subprocess
import threading
import time

PAYLOAD = {"JPEG": (26, "JPEG/90000"), "H264": (96, "H264/90000"), "PCMU": (0, "PCMU/8000")}

PRODUCER = {
    "JPEG": ["videotestsrc", "is-live=true", "pattern=smpte", "!",
             "video/x-raw,format=I420,width=320,height=240,framerate=10/1", "!", "jpegenc", "!",
             "rtpjpegpay", "pt=26", "mtu=1400"],
    "PCMU": ["audiotestsrc", "is-live=true", "freq=1000", "volume=0.5", "!",
             "audio/x-raw,rate=8000,channels=1", "!", "mulawenc", "!", "rtppcmupay", "pt=0"],
}


class FakeCamera:
    def __init__(self, tracks):
        self.tracks = tracks
        self.setups = []      # track indexes, in the order they were SETUP
        self.requests = []    # every request's method
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.2)
        self.port = self.server.getsockname()[1]
        self.url = f"rtsp://127.0.0.1:{self.port}/cam"
        self.done = threading.Event()
        self.procs = []
        self.threads = []
        self.feeds_lock = threading.Lock()
        self.feeds = {}    # codec -> [(connection, its lock, channel)]
        self.packets = {}  # codec -> packets produced so far
        for codec in {t["codec"] for t in tracks if t["codec"] in PRODUCER}:
            self.feeds[codec] = []
            self._produce(codec)
        self.threads.append(threading.Thread(target=self._accept, daemon=True))
        self.threads[-1].start()

    def sdp(self):
        lines = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=fpp-tests camera", "c=IN IP4 0.0.0.0",
                 "t=0 0", "a=control:*"]
        for i, t in enumerate(self.tracks):
            pt, rtpmap = PAYLOAD[t["codec"]]
            lines += [f"m={t['media']} 0 RTP/AVP {pt}", f"a=rtpmap:{pt} {rtpmap}"]
            if t["codec"] == "H264":
                lines.append(f"a=fmtp:{pt} packetization-mode=1")
            lines.append(f"a=control:track{i}")
        return "\r\n".join(lines) + "\r\n"

    def _accept(self):
        while not self.done.is_set():
            try:
                conn, _ = self.server.accept()
            except (socket.timeout, OSError):
                continue
            t = threading.Thread(target=self._serve, args=(conn,), daemon=True)
            self.threads.append(t)
            t.start()

    def _serve(self, conn):
        lock = threading.Lock()
        channels = {}  # track index -> interleaved RTP channel
        buf = b""
        conn.settimeout(0.2)
        try:
            while not self.done.is_set():
                # Interleaved frames from the client (RTCP receiver reports).
                while buf.startswith(b"$") and len(buf) >= 4:
                    n = int.from_bytes(buf[2:4], "big")
                    if len(buf) < 4 + n:
                        break
                    buf = buf[4 + n:]
                head, sep, rest = buf.partition(b"\r\n\r\n")
                if sep and not buf.startswith(b"$"):
                    lines = head.decode(errors="replace").split("\r\n")
                    headers = {}
                    for l in lines[1:]:
                        k, _, v = l.partition(":")
                        headers[k.strip().lower()] = v.strip()
                    body_len = int(headers.get("content-length", "0"))
                    if len(rest) < body_len:
                        buf += self._recv(conn)
                        continue
                    buf = rest[body_len:]
                    self._answer(conn, lock, lines[0], headers, channels)
                    continue
                data = self._recv(conn)
                if data is None:
                    return
                buf += data
        finally:
            with self.feeds_lock:
                for subs in self.feeds.values():
                    subs[:] = [x for x in subs if x[0] is not conn]
            conn.close()

    @staticmethod
    def _recv(conn):
        try:
            data = conn.recv(65536)
        except socket.timeout:
            return b""
        except OSError:
            return None
        return data if data else None

    def _answer(self, conn, lock, request, headers, channels):
        method, url = (request.split() + ["", ""])[:2]
        self.requests.append(method)
        out = [f"RTSP/1.0 200 OK", f"CSeq: {headers.get('cseq', '0')}"]
        body = ""
        if method == "OPTIONS":
            out.append("Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER, SET_PARAMETER")
        elif method == "DESCRIBE":
            body = self.sdp()
            out += ["Content-Type: application/sdp", f"Content-Base: {self.url}/"]
        elif method == "SETUP":
            m = re.search(r"track(\d+)", url)
            idx = int(m.group(1)) if m else -1
            self.setups.append(idx)
            transport = headers.get("transport", "")
            ch = re.search(r"interleaved=(\d+)", transport)
            channels[idx] = int(ch.group(1)) if ch else 2 * len(channels)
            out += [f"Transport: RTP/AVP/TCP;unicast;interleaved={channels[idx]}-{channels[idx] + 1}",
                    "Session: 4711;timeout=60"]
        elif method == "PLAY":
            out += ["Session: 4711", "Range: npt=0.000-"]
        elif method in ("TEARDOWN", "GET_PARAMETER", "SET_PARAMETER"):
            out.append("Session: 4711")
        else:
            out = ["RTSP/1.0 501 Not Implemented", f"CSeq: {headers.get('cseq', '0')}"]
        if body:
            out.append(f"Content-Length: {len(body)}")
        msg = ("\r\n".join(out) + "\r\n\r\n" + body).encode()
        with lock:
            conn.sendall(msg)
        if method == "PLAY":
            for idx, ch in channels.items():
                if 0 <= idx < len(self.tracks):
                    self._stream(conn, lock, self.tracks[idx]["codec"], ch)

    def _stream(self, conn, lock, codec, channel):
        if codec in self.feeds:
            with self.feeds_lock:
                self.feeds[codec].append((conn, lock, channel))

    def _produce(self, codec):
        """Run codec's producer from the start (a cold gst-launch can take
        seconds to scan its plugins), and copy its packets to every
        connection that has PLAYed a track of it."""
        rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rx.bind(("127.0.0.1", 0))
        rx.settimeout(0.2)
        port = rx.getsockname()[1]
        self.procs.append(subprocess.Popen(
            ["gst-launch-1.0", "-q", *PRODUCER[codec], "!", "udpsink", "host=127.0.0.1", f"port={port}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

        def pump():
            try:
                while not self.done.is_set():
                    try:
                        pkt = rx.recv(65536)
                    except socket.timeout:
                        continue
                    self.packets[codec] = self.packets.get(codec, 0) + 1
                    with self.feeds_lock:
                        subs = list(self.feeds[codec])
                    for conn, lock, channel in subs:
                        try:
                            with lock:
                                conn.sendall(b"$" + bytes([channel]) + len(pkt).to_bytes(2, "big") + pkt)
                        except OSError:  # the client went away
                            with self.feeds_lock:
                                if (conn, lock, channel) in self.feeds[codec]:
                                    self.feeds[codec].remove((conn, lock, channel))
            finally:
                rx.close()
        t = threading.Thread(target=pump, daemon=True)
        self.threads.append(t)
        t.start()

    def close(self):
        self.done.set()
        for p in self.procs:
            p.kill()
            p.wait()
        for t in self.threads:
            t.join(2)
        self.server.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
