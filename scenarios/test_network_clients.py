"""fppd's network clients -- CurlManager, PingManager and controller
detection -- driven from a native plugin (nettestplugin.cpp, built by
plugin_build.py) from threads of its own and from inside their callbacks,
the ways a plugin may use them.

The curl and ping-thread races show only under TSan (run.sh --flavor tsan),
which reports an unsynchronized access whether or not the two sides happen
to overlap; the harness fails a scenario on any report."""

import http.server
import os
import threading
import time

import plugin_build
from fake_devices import fake_devices, page

PLUGIN = "fpp-nettest"


def start_with_plugin(fppd):
    plugin_build.build_and_install(fppd, "nettestplugin.cpp", PLUGIN)
    fppd.start()
    fppd.wait_for(lambda: f"{PLUGIN} Curl Threads" in {c["name"] for c in fppd.get("/commands")},
                  timeout=15, interval=0.25, what="the test plugin to load")


class OkServer:
    """An HTTP server on every loopback address that answers "ok", on a port
    of its own, so each 127.0.x.y is a new host to curl."""

    def __init__(self):
        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            def log_message(self, *a):
                pass
        self.server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def test_synchronous_requests_from_two_plugin_threads_at_once(fppd):
    """Two plugin threads each making synchronous GETs (doGet) at once, each
    request to a host curl hasn't seen: every request comes back with its
    body, and nothing is shared between the threads unsynchronized.

    Regression: b01cfdd19. createCurl() looked up the host's credentials --
    inserting the host into the map on its first request -- without the
    lock setHostUsernamePassword() takes, so two first requests to new hosts
    inserted at once.

    Regression: 332b1dda1. processCurls(), inline in the header, read the
    request count without the lock from every thread that pumps curl, while
    a completion on another thread changed it.

    Regression: 8f5269781. doGet() waited on a flag in its own frame, ending
    the wait as soon as processCurls() found nothing in flight. With the
    other thread pumping too, that thread could complete this request,
    dropping the count before running the callback: doGet() then returned
    with the flag unset, and the callback wrote it into the frame it had
    left."""
    server = OkServer()
    try:
        start_with_plugin(fppd)
        for _ in range(3):
            got = fppd.command(f"{PLUGIN} Curl Threads", "2", "100", str(server.port), timeout=60)
            assert str(got) == "200/200", got
    finally:
        server.close()


def test_a_ping_timeout_callback_can_ping_again(fppd):
    """A one-shot ping that times out, whose callback pings another host --
    retrying elsewhere, as a plugin may: the second ping is sent and its
    answer comes back, and fppd stops cleanly.

    Regression: 2dd7d0151. The ping thread ran timeout callbacks holding
    targetLock, which is not recursive, and ping() takes it: the callback
    deadlocked the ping thread, so no ping was answered from then on and
    fppd's shutdown hung joining it."""
    result = os.path.join(fppd.media, "tmp", "ping-again")
    start_with_plugin(fppd)
    # 192.0.2.1 (TEST-NET-1) never answers.
    fppd.command(f"{PLUGIN} Ping Again", "192.0.2.1", "100", "127.0.0.1", result, timeout=10)
    fppd.wait_for(lambda: os.path.exists(result), timeout=10, interval=0.25,
                  what="the ping sent from the timeout callback to be answered")
    assert int(open(result).read()) > 0, "the second ping timed out"


def test_the_ping_thread_stops_cleanly(fppd):
    """fppd pinging a host, then stopped: the ping thread sees the stop and
    ends, with nothing shared between it and the stopping thread
    unsynchronized (the harness checks for reports once fppd has stopped).

    Regression: dc7cd4391. The ping thread looped on a volatile int that
    Cleanup() cleared from the main thread, a data race on every stop."""
    start_with_plugin(fppd)
    result = os.path.join(fppd.media, "tmp", "ping-again")
    fppd.command(f"{PLUGIN} Ping Again", "192.0.2.1", "100", "127.0.0.1", result, timeout=10)
    fppd.wait_for(lambda: os.path.exists(result), timeout=10, interval=0.25,
                  what="the ping thread to answer")
    time.sleep(0.5)


WLED = {
    "/": page("<html><title>WLED UI</title></html>"),
    "/json/info": page({"ver": "0.14.1", "name": "fake-wled", "arch": "esp32",
                        "mac": "aabbcc000005"}),
}


def test_a_detection_callback_that_throws_is_contained(fppd):
    """Controller detection of a WLED (claimed from its /json/info reply)
    whose caller's callback throws: the throw is logged, and fppd carries on
    with the detection's memory left alone.

    Regression: f62ec0227. finish() deleted the Detection and then ran the
    callback from inside the detector's reply handler; a throw went back up
    to deliver(), whose catch took it for an unreadable reply and called
    noMatch() on the Detection just deleted: a heap-use-after-free under
    ASan."""
    with fake_devices({"10.88.0.5": WLED}):
        start_with_plugin(fppd)
        fppd.command(f"{PLUGIN} Detect Throwing", "10.88.0.5", timeout=15)
        fppd.wait_for(lambda: "fpp-tests: detected, and threw" in fppd.log(), timeout=10,
                      interval=0.25, what="the callback's throw to be logged")
        fppd.check_alive()
        assert fppd.get("/fppd/status").get("fppd") == "running"
