"""Video input sources whose configured values aren't plain words: what
VideoInputManager splices into the GStreamer pipeline it builds for them."""

import os
import socket
import threading

from test_video import SOURCE, make_video, overlay_consumer, setup, source


class RtspListener:
    """A TCP port that takes rtspsrc's connection and keeps the first request
    line it sends (OPTIONS or DESCRIBE <url> RTSP/1.0), answering nothing."""

    def __init__(self):
        self.sock = socket.create_server(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.sock.settimeout(0.2)
        self.lines = []
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while self.running:
            try:
                c, _ = self.sock.accept()
            except OSError:
                continue
            c.settimeout(2)
            data = b""
            try:
                while b"\r\n" not in data:
                    chunk = c.recv(4096)
                    if not chunk:
                        break
                    data += chunk
            except OSError:
                pass
            c.close()
            if data:
                self.lines.append(data.split(b"\r\n")[0].decode(errors="replace"))

    def close(self):
        self.running = False
        self.thread.join()
        self.sock.close()


def test_an_rtsp_source_whose_url_has_a_space_and_a_backslash_asks_for_it(fppd, audio):
    """An rtspsrc video input source whose URL path holds a space and a
    backslash: rtspsrc connects to the server and asks it for that path,
    exactly.

    Regression: 7b11b9d9f. The URL was spliced into the gst_parse_launch()
    description bare, so the space ended the location: rtspsrc asked the
    server for "/a", and a backslash on its own would have been swallowed
    by the parser."""
    rtsp = RtspListener()
    try:
        url = f"rtsp://127.0.0.1:{rtsp.port}/a b\\c"
        setup(fppd, [overlay_consumer(SOURCE)], [source("rtspsrc", uri=url)])
        fppd.start()
        fppd.wait_for(lambda: rtsp.lines, timeout=20, what="rtspsrc to ask the server for the stream")
        line = rtsp.lines[0]
    finally:
        rtsp.close()
    # rtspsrc sends the URL as it was given, space and all.
    assert line.split(" ", 1)[0] in ("OPTIONS", "DESCRIBE"), line
    assert line.endswith(f"{url} RTSP/1.0"), line


def test_a_source_with_a_control_character_is_refused(fppd, audio):
    """A video input source whose URI holds a newline is not started: fppd
    raises the video input warning naming the source, and keeps running.

    Regression: 7b11b9d9f. Control characters have no form in the
    gst_parse_launch() grammar; the URI went in as it was, with no warning
    for the source."""
    path = os.path.join(fppd.media, "videos", "Bars.mkv")
    make_video(path, seconds=4)
    setup(fppd, [overlay_consumer(SOURCE)], [source("urisrc", uri="file://" + path + "\n")])
    fppd.start()

    def warned():
        return [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                if "Video input 'Test' has an invalid URI" in w.get("message", "")]
    fppd.wait_for(warned, timeout=15, what="the invalid-URI warning for the source")
