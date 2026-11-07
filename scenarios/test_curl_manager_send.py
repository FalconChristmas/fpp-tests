"""CurlManager's synchronous doPost() and doPut(), through a plugin
(tools/curlsendplugin.cpp): fpp itself no longer calls them, so a plugin is
what depends on them.
"""

import http.server
import socket
import threading
import urllib.parse

import pytest

import throw_plugin


class _Recorder(http.server.BaseHTTPRequestHandler):
    """Records each request and answers with the server's status and body."""
    protocol_version = "HTTP/1.1"

    def _answer(self):
        # Chunked framing decides the body over any Content-Length (RFC 9112
        # 6.3). Read either, so a body sent with the wrong framing is still
        # compared, and the framing itself is checked on its own.
        if "chunked" in self.headers.get("Transfer-Encoding", ""):
            body = b""
            while True:
                size = int(self.rfile.readline().strip(), 16)
                body += self.rfile.read(size)
                self.rfile.readline()
                if size == 0:
                    break
        else:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.server.requests.append((self.command, self.path, self.headers.get("Content-Type"), body))
        self.server.framing.append((self.headers.get("Transfer-Encoding"), self.headers.get_all("Content-Length")))
        reply = self.server.reply
        self.send_response(self.server.status)
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    do_POST = _answer
    do_PUT = _answer

    def log_message(self, *args):
        pass


@pytest.fixture
def recorder():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Recorder)
    server.requests, server.framing, server.status, server.reply = [], [], 200, b"stored"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()


def send(fppd, method, url, size=0, type_="application/x-fpp-test"):
    """(rc, returned string) of one doPost() or doPut()."""
    query = urllib.parse.urlencode({"method": method, "url": url, "size": size, "type": type_})
    rc, _, returned = fppd.get(f"/curlsend?{query}", timeout=30).partition("\n")
    return int(rc), returned


def load(fppd):
    throw_plugin.install(fppd, source="curlsendplugin.cpp", name="fpp-curlsend")
    fppd.start()
    fppd.post("/fppd/plugin/fpp-curlsend/load", {}, timeout=40)


@pytest.mark.parametrize("method", ["POST", "PUT"])
@pytest.mark.parametrize("size", [0, 20, 300000], ids=["empty", "small", "many-read-buffers"])
def test_the_body_arrives_whole_with_its_type(fppd, recorder, method, size):
    """The server sees the method, path, content type and every byte, however
    many reads curl takes to send them, and the caller gets the status and
    the reply."""
    load(fppd)
    url = f"http://127.0.0.1:{recorder.server_address[1]}/store/it"
    assert send(fppd, method, url, size) == (200, "stored")
    want = bytes(i % 251 for i in range(size))
    assert len(recorder.requests) == 1
    got_method, path, content_type, body = recorder.requests[0]
    assert (got_method, path, content_type) == (method, "/store/it", "application/x-fpp-test")
    assert body == want


@pytest.mark.parametrize("method", ["POST", "PUT"])
@pytest.mark.parametrize("size", [0, 20, 300000], ids=["empty", "small", "many-read-buffers"])
def test_the_body_is_framed_by_its_length_alone(fppd, recorder, method, size):
    """The request says how long its body is once, in a Content-Length, and is
    not also chunked: RFC 9112 forbids both, and a server that goes by the
    Content-Length reads the chunk framing as the body.

    Regression: 294720880. doPut() set CURLOPT_POSTFIELDSIZE, which an upload ignores, so
    curl chunked the body under the Content-Length it had been handed."""
    load(fppd)
    url = f"http://127.0.0.1:{recorder.server_address[1]}/store/it"
    assert send(fppd, method, url, size) == (200, "stored")
    assert recorder.framing == [(None, [str(size)])]


@pytest.mark.parametrize("method", ["POST", "PUT"])
def test_an_error_status_comes_back_with_its_body(fppd, recorder, method):
    """A server's refusal is an answer, not a failed transfer: the caller
    gets its status and what it said."""
    recorder.status, recorder.reply = 507, b"out of room"
    load(fppd)
    url = f"http://127.0.0.1:{recorder.server_address[1]}/store/it"
    assert send(fppd, method, url, 20) == (507, "out of room")


@pytest.mark.parametrize("method", ["POST", "PUT"])
def test_a_server_that_isnt_there_is_rc_0_and_a_reason(fppd, method):
    """Nothing listening: rc 0 and a reason rather than a hang or a false
    success, and fppd can go on to serve the next request."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    load(fppd)
    rc, reason = send(fppd, method, f"http://127.0.0.1:{port}/store/it", 20)
    assert rc == 0, reason
    assert reason, "no reason for the failed transfer"
    assert fppd.get("/fppd/status").get("fppd") == "running"
