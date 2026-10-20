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


def test_two_tasks_with_one_name_run_the_first(fppd, endpoint):
    """Of two tasks with the same name, the first runs and the second is
    skipped at load.

    Regression: 5620959b0. The name was the task's timer id, so the second
    task's timer replaced the first's before it ever fired: the first task
    never ran."""
    a, b = endpoint("a"), endpoint("b")
    fppd.write("config/recurringtasks.json", [url_task("dup", a.url), url_task("dup", b.url)])
    fppd.start()
    time.sleep(4)
    assert (a.hits, b.hits) == (1, 0), f"first task ran {a.hits} times, second {b.hits}"


def test_a_task_cannot_take_over_a_future_preset(fppd, endpoint):
    """A task whose name is the timer id a pending "Trigger Command Preset
    In Future" uses ("preset:T") leaves that preset to fire.

    Regression: 5620959b0. Task timers and every other timer shared one
    namespace, so the task's timer replaced the pending preset's, which
    then never fired."""
    ep = endpoint("x")
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "P", "command": "Set Variable", "args": ["Fired", "Value", "yes"],
        "multisyncCommand": False}]})
    fppd.start()
    fppd.command("Trigger Command Preset In Future", "T", "3000", "P")
    fppd.write("config/recurringtasks.json", [url_task("preset:T", ep.url)])
    fppd.post("/fppd/recurringtasks", {"command": "reload"})
    fppd.wait_for(lambda: variable(fppd, "Fired") == "yes", timeout=6,
                  what="the future preset to fire")


def test_regex_over_a_result_past_its_limit_is_reported(fppd, endpoint):
    """A regex filter over a result longer than it searches (16 KB) is
    reported as a failed run that says why, and the variable keeps its
    value; a result just under the limit is searched to its end.

    Regression: 4c1d47ea4. 522c7b196 searched only the first 16 KB, so a
    value past it (a weather service's JSON with the field near the end)
    came back empty while the task's Status said the run succeeded."""
    big = endpoint("x" * 20000 + '"temp": 21.5')
    small = endpoint("x" * 16000 + '"temp": 19.5')
    fppd.start()
    pattern = r'"temp": ([0-9.]+)'
    r = fppd.post("/fppd/recurringtasks", {"command": "test", "task": url_task(
        "t", small.url, filterType="regex", filterRegex=pattern)}, timeout=30)
    assert r["ok"] is True and r["filtered"] == "19.5", {k: str(v)[:80] for k, v in r.items()}
    r = fppd.post("/fppd/recurringtasks", {"command": "test", "task": url_task(
        "t", big.url, filterType="regex", filterRegex=pattern)}, timeout=30)
    assert r["ok"] is False and "16 KB" in r["error"], {k: str(v)[:80] for k, v in r.items()}
    assert variable(fppd, "t") == "19.5"
    fppd.write("config/recurringtasks.json", [url_task(
        "t", big.url, filterType="regex", filterRegex=pattern)])
    fppd.post("/fppd/recurringtasks", {"command": "reload"})
    fppd.wait_for(lambda: big.hits >= 2, timeout=10, what="the saved task to run")
    s = fppd.wait_for(lambda: (task_status(fppd, "t") or {}).get("lastError") and task_status(fppd, "t"),
                      timeout=5, what="the saved task's status")
    assert s["lastOk"] is False and "16 KB" in s["lastError"], s


def test_regex_over_a_long_run_does_not_overflow_the_stack(fppd, endpoint):
    """A regex filter whose repeat runs over most of a result within the
    limit (12,000 digits for "temp:(\\d+)") is answered with the whole run,
    and fppd carries on.

    Regression: 4c1d47ea4. libstdc++'s backtracking std::regex recursed
    once per repeated character, and 522c7b196's 16 KB cap was not enough:
    under ASan 12 KB of digits overflowed a drogon thread's stack
    (SIGSEGV), and 16 KB of "(.|\\n)*" overflows an 8 MB stack in an
    optimized build, on the main loop for a saved task, every interval."""
    ep = endpoint("temp:" + "1" * 12000)
    fppd.start()
    r = fppd.post("/fppd/recurringtasks", {"command": "test", "task": url_task(
        "t", ep.url, filterType="regex", filterRegex=r"temp:(\d+)")}, timeout=30)
    fppd.check_alive()
    assert r["ok"] is True and r["filtered"] == "1" * 12000, {k: str(v)[:80] for k, v in r.items()}


@pytest.mark.parametrize("pattern,body,expected", [
    # ECMAScript takes the first alternative that matches, not the longest
    (r"(foo|foobar)", "foobar", "foo"),
    (r"(\w)\1", "abccd", "c"),
    (r"<b>(.*?)</b>", "<b>one</b><b>two</b>", "one"),
], ids=["first-alternative", "backreference", "lazy"])
def test_regex_filter_keeps_ecmascript_semantics(fppd, endpoint, pattern, body, expected):
    """A regex filter matches the way ECMAScript (std::regex's default) says:
    the first alternative that matches wins, backreferences work, and a lazy
    repeat stops at the first chance. Saved filters rely on it, so
    4c1d47ea4 fixed the stack overflow by giving the backtracking engine a
    bigger stack, not by switching to a leftmost-longest engine (libstdc++'s
    __polynomial), which gives "foobar" and refuses backreferences."""
    ep = endpoint(body)
    fppd.start()
    r = fppd.post("/fppd/recurringtasks", {"command": "test", "task": url_task(
        "t", ep.url, filterType="regex", filterRegex=pattern)}, timeout=30)
    assert r["ok"] is True and r["filtered"] == expected, r
