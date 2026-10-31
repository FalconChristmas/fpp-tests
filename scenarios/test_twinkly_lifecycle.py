"""The Twinkly output's authentication and token timer across the output's
own life: a login still in flight when output stops, a login that never
answers while other outputs run, and an output deleted after its pings
failed. The lights are fakes in their own network namespace
(fake_devices.py), as in test_twinkly_output.py."""

import json
import os
import sys
import tempfile
import time

import pytest

from ddp import DdpReceiver
from fake_devices import DEV_IF, NETNS, _ip, device_network
from show import ddp_output
from test_twinkly_output import ADDR, HANG_SERVER, lights, setup, show_color, twinkly_output

# Lights whose login answers only after LOGIN_DELAY seconds; every POST is
# logged to argv[2] as a JSON line (path, body, monotonic time).
SLOW_LOGIN = """\
import http.server, json, sys, threading, time
ADDR, LOG, DELAY = sys.argv[1], sys.argv[2], float(sys.argv[3])
lock = threading.Lock()
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def reply(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode(errors="replace")
        with lock, open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "body": body, "t": time.monotonic()}) + "\\n")
        if self.path == "/xled/v1/login":
            time.sleep(DELAY)
            self.reply({"authentication_token": "AAECAwQFBgc=", "authentication_token_expires_in": 14400,
                        "challenge-response": "00", "code": 1000})
        else:
            self.reply({"code": 1000})
    do_GET = do_POST
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer((ADDR, 80), H)
srv.daemon_threads = True
print("ready", flush=True)
srv.serve_forever()
"""


def posts(log):
    try:
        with open(log) as f:
            return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError:
        return []


def test_a_login_in_flight_when_output_stops_does_not_restart_realtime(fppd):
    """Output stops (Test Stop) while the lights' login is still
    unanswered; when the login answers afterwards, fppd does not go on to
    verify and put the lights back into realtime mode with nothing left to
    send them frames.

    Regression: fba3eb4e3. The asynchronous login chain didn't know the
    output had stopped: it ran to the end after the stop and left the
    lights in "rt" mode, frozen on nothing.
    """
    setup(fppd, 300)
    log = tempfile.mktemp(prefix="twinkly-slow-", suffix=".jsonl")
    try:
        with device_network([ADDR]) as run:
            srv = run(sys.executable, "-I", "-c", SLOW_LOGIN, ADDR, log, "3")
            assert srv.stdout.readline().strip() == "ready"
            fppd.start()
            show_color(fppd, 300)
            fppd.wait_for(lambda: any(p["path"] == "/xled/v1/login" for p in posts(log)),
                          timeout=15, what="the login to be asked for")
            fppd.command("Test Stop")
            stopped = time.monotonic()
            time.sleep(6)  # the login answers 3 s after it was asked
            late = [p for p in posts(log) if p["t"] > stopped and p["path"] == "/xled/v1/led/mode"
                    and '"rt"' in p["body"]]
            assert not late, f"realtime mode set after the output stopped: {late}"
    finally:
        if os.path.exists(log):
            os.unlink(log)


def test_a_hung_login_at_start_does_not_hold_up_other_outputs(fppd):
    """A Twinkly whose lights accept the login connection and never answer
    doesn't hold up the output thread when output starts: a DDP output
    next to it gets frames without a gap through the first 10 s.

    Regression: c533a33bb. The login, verify and realtime-mode calls were
    made synchronously from StartingOutput() on the channel output thread,
    so every output stopped until the hung login timed out.
    """
    c = ddp_output(150)
    c["channelOutputs"][0]["channelCount"] = 450
    c["channelOutputs"][0]["universes"].append(
        dict(twinkly_output(300)["channelOutputs"][0]["universes"][0], startChannel=151))
    fppd.write("config/co-universes.json", c)
    fppd.settings(DisableFakeNetworkBridges="1")
    with device_network([ADDR]) as run, DdpReceiver(150) as rx:
        srv = run(sys.executable, "-I", "-c", HANG_SERVER, ADDR)
        assert srv.stdout.readline().strip() == "ready"
        fppd.start()
        since = time.monotonic()
        fppd.request("PUT", "/overlays/range/1-450", {"Value": 42})
        time.sleep(10)
        times = [since] + [t for t, _ in rx.snapshot(since=since)] + [time.monotonic()]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert len(times) > 20, f"only {len(times) - 2} DDP frames in 10 s"
    assert max(gaps) < 2.5, f"DDP stopped for {max(gaps):.1f} s while the Twinkly login hung"


def test_an_unreachable_twinkly_deleted_by_a_reload_leaves_no_timer(fppd):
    """Monitored lights that stop answering fppd's pings mid-show (their
    output goes invalid), then a save of the outputs that drops them: past
    the 120 s the output's token check runs on, fppd is still up.

    Regression: 6ceaf0cee. StartingOutput() armed a periodic token check
    that captured the output, and only StoppingOutput() removed it -- which
    UDPOutput only passed on to outputs still valid. One whose pings had
    failed was deleted by the reload with the timer still armed, and
    verifyToken() ran on the freed output: an ASan heap-use-after-free at
    the 120 s mark. Slow: it has to wait for that timer.
    """
    config = twinkly_output(300)
    config["channelOutputs"][0]["universes"][0]["monitor"] = 1
    fppd.write("config/co-universes.json", config)
    fppd.settings(DisableFakeNetworkBridges="1")
    with lights() as tw:
        fppd.start()
        show_color(fppd, 300)
        fppd.wait_for(lambda: tw.realtime_token(), timeout=15, what="realtime mode")
        armed = time.monotonic()  # the output started, and with it the timer
        _ip("addr", "del", ADDR + "/24", "dev", DEV_IF, ns=NETNS)
        fppd.wait_for(lambda: [w for w in fppd.get("/fppd/status").get("warningInfo", [])
                               if w.get("id") == 27],
                      timeout=90, interval=1, what="fppd to give up on the lights")
        time.sleep(1.1)  # a save in a later second
        fppd.write("config/co-universes.json", ddp_output(150))
        fppd.wait_for(lambda: fppd.log().count("Calling Init() on UDPOutput output") >= 2,
                      timeout=15, what="the outputs to reload")
        while time.monotonic() < armed + 130:
            fppd.check_alive()
            time.sleep(1)
        fppd.get("/fppd/status")


# Lights that answer the first PATH call (login or verify) with BODY, a
# reply no Twinkly sends (a captive portal's page, a half-booted
# controller's JSON), and every call after it as a Twinkly does. Every POST
# is logged to LOG as a JSON line (path, body).
BAD_REPLY = """\
import http.server, json, sys, threading
ADDR, LOG, PATH, BODY = sys.argv[1:5]
lock = threading.Lock()
bad = {"left": 1}
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def reply(self, body):
        body = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode(errors="replace")
        with lock:
            with open(LOG, "a") as f:
                f.write(json.dumps({"path": self.path, "body": body}) + "\\n")
            first = self.path == "/xled/v1/" + PATH and bad["left"] > 0
            if first:
                bad["left"] -= 1
        if first:
            self.reply(BODY)
        elif self.path == "/xled/v1/login":
            self.reply(json.dumps({"authentication_token": "AAECAwQFBgc=", "code": 1000}))
        else:
            self.reply(json.dumps({"code": 1000}))
    do_GET = do_POST
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer((ADDR, 80), H)
srv.daemon_threads = True
print("ready", flush=True)
srv.serve_forever()
"""


@pytest.mark.parametrize("path, body", [
    ("login", "<html><body>please wait</body></html>"),
    ("login", '["please wait"]'),
    ("login", '{"authentication_token": {"pending": true}, "code": 1000}'),
    ("verify", '["please wait"]'),
], ids=["login html", "login array", "login token object", "verify array"])
def test_a_reply_no_twinkly_sends_is_retried(fppd, path, body):
    """Lights whose first login or verify reply is not a Twinkly's -- an
    HTML page, a JSON array, a token that is not a string -- leave fppd
    running and answering, and the output logs in again and gets the
    lights into realtime mode once they answer properly.

    Regression: 7638be7a7 (the login reply) and 458214811 (the verify
    reply). jsoncpp throws when a non-object is asked for a member or an
    object for a string; unguarded, that ended fppd on the first light that
    was not quite a Twinkly. CurlManager now contains a throw from any
    reply handler (c8ccf32a0), so without the guards fppd stays up but the
    login chain dies half way: it never clears its in-flight mark, and the
    output never logs in again."""
    setup(fppd, 300)
    log = tempfile.mktemp(prefix="twinkly-bad-", suffix=".jsonl")
    try:
        with device_network([ADDR]) as run:
            srv = run(sys.executable, "-I", "-c", BAD_REPLY, ADDR, log, path, body)
            assert srv.stdout.readline().strip() == "ready"
            fppd.start()
            show_color(fppd, 300)
            fppd.wait_for(lambda: any(p["path"] == "/xled/v1/" + path for p in posts(log)),
                          timeout=20, what=f"the Twinkly output to call {path}")
            fppd.get("/fppd/status")
            fppd.check_alive()
            fppd.wait_for(lambda: any(p["path"] == "/xled/v1/led/mode" and '"rt"' in p["body"]
                                      for p in posts(log)),
                          timeout=30, interval=0.5,
                          what=f"realtime mode after the bad {path} reply")
            fppd.check_alive()
    finally:
        if os.path.exists(log):
            os.unlink(log)
