"""Recurring Tasks (config/recurringtasks.json): a command or a command
preset run on an interval, a command's output filtered (JSON path, between
two markers, or a regex) into a variable, the Status the admin page shows,
the page's Test Run, and a reload after the page saves."""

import http.server
import json
import threading
import time

import pytest


class Endpoint:
    """A local HTTP server answering every GET with `body`, and counting."""

    def __init__(self, body):
        self.body = body.encode()
        self.hits = 0
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.hits += 1
                self.send_response(200)
                self.send_header("Content-Length", str(len(outer.body)))
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/data"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture
def endpoint():
    eps = []

    def make(body):
        ep = Endpoint(body)
        eps.append(ep)
        return ep
    yield make
    for ep in eps:
        ep.close()


def url_task(name, url, **extra):
    t = {"name": name, "enabled": True, "intervalMS": 60000, "type": "command",
         "command": "URL", "args": [url, "GET", ""], "resultVariable": name}
    t.update(extra)
    return t


def variable(fppd, name):
    return (fppd.get("/variables") or {}).get(name, {}).get("value")


def task_status(fppd, name):
    for t in fppd.get("/fppd/recurringtasks")["tasks"]:
        if t["name"] == name:
            return t
    return None


WEATHER = json.dumps({"data": {"temperature": 21.5, "city": "Here"}, "list": [1, 2]})


def test_command_task_fills_its_variable_through_each_filter(fppd, endpoint):
    """Each filter type pulls its piece out of the fetched JSON, and each
    task's Status says it ran."""
    ep = endpoint(WEATHER)
    tasks = [
        url_task("raw", ep.url),
        url_task("json", ep.url, filterType="json", filterJsonPath="data.temperature"),
        url_task("between", ep.url, filterType="between", filterBetweenStart='"city": "',
                 filterBetweenEnd='"'),
        url_task("regex", ep.url, filterType="regex", filterRegex=r'"temperature": ([0-9.]+)'),
        url_task("missing", ep.url, filterType="json", filterJsonPath="data.nope"),
    ]
    fppd.write("config/recurringtasks.json", tasks)
    fppd.start()
    # First runs are staggered a second apart in file order.
    fppd.wait_for(lambda: all((task_status(fppd, t["name"]) or {}).get("hasRun") for t in tasks),
                  timeout=15, interval=0.5, what="every task's first run")
    assert variable(fppd, "raw") == WEATHER
    assert variable(fppd, "json") == "21.5"
    assert variable(fppd, "between") == "Here"
    assert variable(fppd, "regex") == "21.5"
    assert variable(fppd, "missing") == ""
    assert all(task_status(fppd, t["name"])["lastOk"] for t in tasks)


def test_preset_task_triggers_its_preset(fppd):
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "Mark", "command": "Set Variable",
        "args": ["mark", "Value", "7"], "multisyncCommand": False}]})
    fppd.write("config/recurringtasks.json", [{"name": "p", "enabled": True,
                                               "intervalMS": 60000, "type": "preset",
                                               "preset": "Mark"}])
    fppd.start()
    fppd.wait_for(lambda: variable(fppd, "mark") == "7", timeout=10,
                  what="the preset task to run")


def test_disabled_task_and_interval_floor(fppd, endpoint):
    """A disabled task never runs, and an interval below the 30 s floor runs
    at the floor, not continuously."""
    fast, off = endpoint("x"), endpoint("y")
    fppd.write("config/recurringtasks.json", [url_task("fast", fast.url, intervalMS=1),
                                              url_task("off", off.url, enabled=False)])
    fppd.start()
    fppd.wait_for(lambda: fast.hits >= 1, timeout=10, what="the first run")
    time.sleep(5)
    assert fast.hits == 1, f"an intervalMS of 1 ran {fast.hits} times in 5 s"
    assert off.hits == 0
    assert task_status(fppd, "fast")["intervalMS"] == 30000


def test_reload_picks_up_a_saved_change(fppd, endpoint):
    """The admin page saves recurringtasks.json and asks fppd to reload: a
    new task runs, and one that was removed is gone from the Status."""
    a, b = endpoint("a"), endpoint("b")
    fppd.write("config/recurringtasks.json", [url_task("a", a.url)])
    fppd.start()
    fppd.wait_for(lambda: a.hits >= 1, timeout=10, what="task a")
    fppd.write("config/recurringtasks.json", [url_task("b", b.url)])
    fppd.post("/fppd/recurringtasks", {"command": "reload"})
    fppd.wait_for(lambda: b.hits >= 1, timeout=10, what="task b after the reload")
    assert [t["name"] for t in fppd.get("/fppd/recurringtasks")["tasks"]] == ["b"]


@pytest.mark.parametrize("task", [
    {"type": "command", "command": "URL", "args": ["URL"], "filterType": "regex",
     "filterRegex": "(unclosed"},
    {"type": "command", "command": "No Such Command"},
    {"type": "command", "command": ""},
    {"type": "preset", "preset": "No Such Preset"},
    {"type": "something else"},
    {},
    {"type": "command", "command": "URL", "args": "not a list"},
    {"name": ["not", "a", "string"], "type": "command", "command": "URL"},
    {"intervalMS": "soon", "type": "command", "command": "URL"},
], ids=lambda t: json.dumps(t)[:50])
def test_test_run_survives_any_task(fppd, endpoint, task):
    """The page's Test Run posts whatever is in the editor; fppd answers and
    carries on, whatever it is."""
    ep = endpoint(WEATHER)
    task = json.loads(json.dumps(task).replace('"URL"]', json.dumps(ep.url) + "]"))
    fppd.start()
    try:
        fppd.post("/fppd/recurringtasks", {"command": "test", "task": task})
    except Exception as e:
        if "HTTP Error" not in str(e):
            raise
    fppd.check_alive()
    assert fppd.get("/fppd/status")["fppd"] == "running"


def test_test_run_reports_the_raw_and_filtered_output(fppd, endpoint):
    ep = endpoint(WEATHER)
    fppd.start()
    r = fppd.post("/fppd/recurringtasks", {"command": "test", "task": url_task(
        "t", ep.url, filterType="json", filterJsonPath="data.city")})
    assert r["ok"] is True and r["raw"] == WEATHER and r["filtered"] == "Here", r
    assert variable(fppd, "t") == "Here"
