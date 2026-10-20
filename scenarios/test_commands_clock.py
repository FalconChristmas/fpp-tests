"""Commands still in flight when the wall clock steps: a recurring task
waiting on its URL, and a Sequential If chain waiting on a URL command
before its next one. Both have a timeout, which must run on the monotonic
clock (Timers' own deadlines: test_clock_steps.py)."""

import http.server
import threading
import time

import pytest

from test_clock_steps import variable
from test_commands import if_command, set_variable


class SlowEndpoint:
    """A local HTTP server that answers every GET after `delay` seconds."""

    def __init__(self, body, delay):
        self.received = threading.Event()
        outer = self
        data = body.encode()

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.received.set()
                time.sleep(delay)
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/slow"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def slow():
    ep = SlowEndpoint("done", 4)
    yield ep
    ep.close()


START = "2026-12-24 18:00:00"
FORWARD = "2026-12-24 20:00:00"


def test_recurring_task_result_survives_a_clock_step(fppd, slow):
    """A recurring task whose URL takes 4 s to answer still gets its result
    into its variable when the wall clock steps two hours forward meanwhile.

    Regression: f9d911d79. The pending result's 60 s timeout was measured on
    the wall clock, so the step "expired" it at once: the task was logged
    as not finishing and its variable never set."""
    fppd.write("config/recurringtasks.json", [{
        "name": "slow", "enabled": True, "intervalMS": 60000, "type": "command",
        "command": "URL", "args": [slow.url, "GET", ""], "resultVariable": "Result"}])
    fppd.start(fake_time=START)
    assert slow.received.wait(10), "the task never requested its URL"
    fppd.set_clock(FORWARD)
    fppd.wait_for(lambda: variable(fppd, "Result") == "done", timeout=8, interval=0.2,
                  what="the task's result after the clock stepped forward")


def test_if_chain_survives_a_clock_step(fppd, slow):
    """A Sequential If chain waiting on a slow URL command runs its next
    command when the URL answers, though the wall clock stepped two hours
    forward meanwhile.

    Regression: f9d911d79. The chain's 60 s timeout was measured on the wall
    clock, so the step abandoned the rest of the chain."""
    fppd.start(fake_time=START)
    fppd.command("Set Variable", "Flag", "Value", "1", "1", "0", "100", "")
    cond = {"source": "Expression", "name": "Flag", "comparator": "equal to", "value": "1"}
    fppd.post("/command", if_command(cond, [{"command": "URL", "args": [slow.url, "GET", ""]},
                                             set_variable("After", "yes")]))
    assert slow.received.wait(10), "the If never requested its URL"
    fppd.set_clock(FORWARD)
    fppd.wait_for(lambda: variable(fppd, "After") == "yes", timeout=8, interval=0.2,
                  what="the command after the URL once the clock stepped forward")
