"""Commands: what fppd does with malformed or hostile command input, from the
places that run commands without an HTTP handler above them."""

import json
import os
import re
import time
import urllib.error
import urllib.parse

import pytest

from show import playlist


def set_variable(name, value):
    return {"command": "Set Variable", "args": [name, "Value", str(value), "1", "0", "100", ""]}


def command_entry(cmd):
    return {"type": "command", "enabled": 1, "playOnce": 0,
            "command": cmd["command"], "args": cmd["args"]}


def variable(fppd, name):
    """One variable's value, "" if it isn't set."""
    # The body is plain text; fppd.get() decodes it as JSON where it can.
    return str(fppd.get("/variables/" + urllib.parse.quote(name), timeout=5))


def if_command(conditions, then_commands):
    return {"command": "If", "args": [json.dumps(conditions), json.dumps(then_commands),
                                      "Sequential", "", "Sequential"]}


def expression_is(name, value):
    return {"source": "Expression", "name": name, "comparator": "equal to", "value": value}


@pytest.mark.parametrize("bad, what", [
    (if_command({"source": "Time", "comparator": "equal to", "value": "x", "not": "x"},
                [set_variable("Never", 1)]),
     'an If whose condition has "not": "x"'),
    ({"command": "Set Variable", "args": ["X", "Random", "", "1", "a", "b", ""]},
     "a Random variable with text bounds"),
])
def test_malformed_command_on_the_main_loop_is_survived(fppd, bad, what):
    """A command that throws while it runs, from a playlist entry on the main
    loop, fails on its own; the playlist goes on to its next entry.

    Regression: 5504aa6e0. Only the HTTP routes caught an exception out of a
    command. A playlist entry, a preset, MultiSync, GPIO and MQTT ran it with
    nothing above, so the throw was std::terminate and fppd died.
    """
    fppd.write("playlists/Bad.json", playlist("Bad", [
        command_entry(bad), command_entry(set_variable("After", "yes"))]))
    fppd.start()
    fppd.command("Start Playlist", "Bad", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "After") == "yes", timeout=10,
                  what=f"the entry after {what} to run")


def nested(depth):
    return "(" * depth + "1" + ")" * depth


def expression(name, text):
    """Set Variable to the value of an expression (leading "=")."""
    return {"command": "Set Variable", "args": [name, "Expression", "", "1", "0", "100", "=" + text]}


def test_deeply_nested_expression_is_refused(fppd):
    """A Set Variable expression nested 100,000 deep (200KB, inside the HTTP
    body limit) is refused, and expressions still work afterwards.

    Regression: 170b4d720. tinyexpr recursed once per nesting level with no
    limit, and ran the request thread out of stack.
    """
    fppd.start()
    try:
        fppd.post("/command", expression("Deep", nested(100000)), timeout=30)
    except urllib.error.HTTPError as e:  # refused is right; fppd has to live
        print(f"deep expression answered: {e}")
    fppd.check_alive()
    fppd.post("/command", expression("Shallow", nested(20) + "+1"))
    assert variable(fppd, "Shallow") == "2"


def test_expression_results_keep_their_magnitude(fppd):
    """An expression whose result prints long (1e30, 31 digits before the
    point) comes back whole, not cut short to a number a hundred times
    smaller.

    Regression: 5b393e21b. The result was printed with "%lf" into a 30-byte
    buffer, so 1e30 came back as its first 29 digits."""
    fppd.start()
    fppd.post("/command", expression("Big", "1e30"))
    assert variable(fppd, "Big") == "1000000000000000019884624838656"


def test_a_variable_named_like_a_number_leaves_the_literal_alone(fppd):
    """With a variable named "2" set, the literal 12 in an expression is
    still twelve.

    Regression: 5b393e21b. A variable whose name isn't an identifier is
    given an alias for tinyexpr, and the alias replaced every occurrence of
    the name as a substring: "12+1" became "1ev0+1", an invalid
    expression."""
    fppd.start()
    fppd.command("Set Variable", "2", "Value", "5", "1", "0", "100", "")
    try:
        fppd.post("/command", expression("Sum", "12+1"))
    except urllib.error.HTTPError as e:
        print(f"the expression answered {e.code}: {e.body}")
    assert variable(fppd, "Sum") == "13"


def test_a_megabyte_expression_is_refused_at_once(fppd):
    """A Set Variable expression of a megabyte of "==1==" markers is refused
    straight away, and fppd answers on.

    Regression: 5b393e21b. The marker scan re-copied the rest of the string
    at every marker, and the length cap applied only to each piece after
    it: a megabyte (well inside the HTTP body limit) held the request
    thread for minutes."""
    fppd.start()
    body = {"command": "Set Variable",
            "args": ["Long", "Expression", "", "1", "0", "100", "==1==" * 200000]}
    began = time.monotonic()
    try:
        fppd.post("/command", body, timeout=20)
    except urllib.error.HTTPError as e:  # refused is right
        print(f"the long expression answered {e.code}")
    took = time.monotonic() - began
    assert took < 5, f"a 1 MB expression took {took:.1f} s to answer"
    fppd.post("/command", expression("After", "1+1"))
    assert variable(fppd, "After") == "2"


@pytest.mark.parametrize("presets, what", [
    ({"commands": {"name": "P"}}, '"commands" given as an object'),
    ({"commands": [5, {"name": {"x": 1}, "command": "Set Variable", "args": []},
                   dict(name="Good", presetSlot=0, **set_variable("Loaded", "yes"))]},
     "an entry that is not an object, and a name that is not text"),
])
def test_malformed_presets_file_does_not_stop_fppd_starting(fppd, presets, what):
    """fppd starts with a commandPresets.json it can only partly read, skips
    what it can't use, and runs the presets it can.

    Regression: 4a31a4f02. The loader indexed whatever the file held, so
    jsoncpp threw out of startup and fppd crashed on every start until the
    file was fixed by hand.
    """
    fppd.write("config/commandPresets.json", presets)
    fppd.start()
    if isinstance(presets["commands"], list):
        fppd.command("Trigger Command Preset", "Good")
        assert variable(fppd, "Loaded") == "yes"


def test_variables_list_with_a_malformed_presets_file(fppd):
    """GET /api/variables lists the variables, and which ones presets use,
    when commandPresets.json holds an entry fppd can't read.

    Regression: 65b0ec341. The "used" scan read the presets file again and
    indexed every entry unchecked; one that wasn't an object threw, and the
    whole list answered 500.
    """
    fppd.write("config/commandPresets.json", {"commands": [
        5, dict(name="Good", presetSlot=0, **set_variable("Loaded", "yes"))]})
    fppd.start()
    fppd.command("Set Variable", "Spare", "Value", "1", "1", "0", "100", "")
    listed = fppd.get("/variables")
    assert listed["Spare"]["used"] is False
    fppd.command("Trigger Command Preset", "Good")
    assert fppd.get("/variables")["Loaded"]["used"] is True


def test_variable_with_a_quote_reaches_the_if_commands(fppd):
    """A %VAR: value containing a double quote is passed intact to the
    commands an If runs.

    Regression: 1b49cba7d. %VAR: substitution pasted the value into the If's
    command list as plain text; the quote broke that JSON, so the If ran an
    empty list, silently.
    """
    fppd.start()
    fppd.command("Set Variable", "Flag", "Value", "1", "1", "0", "100", "")
    fppd.command("Set Variable", "Quoted", "Value", 'say "hi"', "1", "0", "100", "")
    cmd = if_command(expression_is("Flag", "1"), [set_variable("Out", "%VAR:Quoted%")])
    fppd.post("/command", cmd)
    fppd.wait_for(lambda: variable(fppd, "Out"), timeout=5, what="the If's command to run")
    assert variable(fppd, "Out") == 'say "hi"'


def preset(name, cmd):
    return {"name": name, "command": cmd["command"], "args": cmd["args"], "presetSlot": 0}


def counter(name):
    return {"command": "Set Variable", "args": [name, "Increment", "", "1", "0", "100", ""]}


def count(fppd, name):
    v = variable(fppd, name)
    return int(float(v)) if v not in ("", "None") else 0


def test_a_future_preset_cannot_take_over_fppds_own_timers(fppd):
    """"Trigger Command Preset In Future" with an identifier that happens to
    name one of fppd's own timers ("AudioCardPresence", which repeats every
    10 s) runs the preset once.

    Regression: 4cc34c8b1. The identifier went straight into the timer id
    space, and replacing a periodic timer kept its period and swapped in the
    preset: the preset fired every 10 s for good and fppd's own check never
    ran again (with "FileMonitor", where inotify is missing, file
    monitoring stopped)."""
    fppd.write("config/commandPresets.json", {"commands": [preset("Tick", counter("Ticks"))]})
    fppd.start()
    fppd.command("Trigger Command Preset In Future", "AudioCardPresence", "500", "Tick")
    time.sleep(22)
    assert count(fppd, "Ticks") == 1, f"the preset fired {count(fppd, 'Ticks')} times"


@pytest.mark.parametrize("body", ["[1, 2]", '"Set Variable"', '{"command": 5}',
                                  '{"command": ["Set Variable"]}', "not json"])
def test_malformed_bare_command_post_is_a_400(fppd, body):
    """POST /command with a body that isn't a command object answers 400,
    saying what it wanted, not an empty 500.

    Regression: 2eed005ef. The handler logged val["command"].asString()
    before checking the body's shape; the throw came back as an empty 500."""
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.post("/command", body)
    assert e.value.code == 400, (e.value.code, getattr(e.value, "body", ""))


SAFE_PREFIXES = ("Shutdown", "Restart", "Reboot", "Run Script", "URL", "Stop FPPD", "FPPD")


def test_commands_called_with_no_arguments_are_refused(fppd):
    """Every command whose first argument is required, called with none
    (a bare GET /command/<name>), is refused, and fppd carries on.

    Regression: 8eb7d4198. Eight commands read args[0] without a check:
    Play Media, Insert Playlist Immediate and others faulted in the field
    on exactly this call."""
    fppd.start()
    refused = []
    for c in fppd.get("/commands"):
        name = c.get("name", "")
        args = c.get("args", [])
        if not args or args[0].get("optional") or name.startswith(SAFE_PREFIXES):
            continue
        try:
            fppd.get("/command/" + urllib.parse.quote(name))
        except urllib.error.HTTPError:
            refused.append(name)
        fppd.check_alive()
    for name in ("Play Media", "Insert Playlist Immediate", "Start Playlist At Random Item"):
        assert name in refused, f"{name} with no arguments wasn't refused"


def test_variables_on_the_get_command_route(fppd):
    """%VAR:name% in a GET /command/<name>/<args...> is replaced with the
    variable's value, as it is for POSTed commands.

    Regression: a40f343ab."""
    fppd.start()
    fppd.command("Set Variable", "Src", "Value", "seven", "1", "0", "100", "")
    path = "/".join(urllib.parse.quote(p, safe="") for p in
                    ["Set Variable", "Dst", "Value", "%VAR:Src%", "1", "0", "100", ""])
    fppd.get("/command/" + path)
    assert variable(fppd, "Dst") == "seven"


def test_a_preset_naming_a_missing_command_raises_a_warning(fppd):
    """A preset whose command doesn't exist (a removed plugin's) puts up a
    warning naming it when it runs, instead of failing silently.

    Regression: 611f6dd0c."""
    fppd.write("config/commandPresets.json", {"commands": [
        preset("Gone", {"command": "No Such Command", "args": []})]})
    fppd.start()
    try:
        fppd.command("Trigger Command Preset", "Gone")
    except urllib.error.HTTPError:
        pass
    fppd.wait_for(lambda: any('No command found for "No Such Command"' in str(w)
                              for w in fppd.get("/fppd/status").get("warnings", [])),
                  timeout=5, what="the missing-command warning")


def test_a_preset_of_slow_url_commands_does_not_stall_its_caller(fppd):
    """A preset of URL commands to a host that never answers returns at
    once: the transfers carry on in the background.

    Regression: f1ff41e39. The preset dropped each command's result, and
    the result's destructor waited up to a second for its transfer: three
    webhooks to a dead host held the caller (usually the main loop) for
    three seconds."""
    import socket
    sink = socket.socket()
    sink.bind(("127.0.0.1", 0))
    sink.listen(16)  # accepts the connection, never answers
    url = f"http://127.0.0.1:{sink.getsockname()[1]}/hook"
    fppd.write("config/commandPresets.json", {"commands": [
        preset("Hooks", {"command": "URL", "args": [url, "GET", ""]})] * 3})
    fppd.start()
    began = time.monotonic()
    fppd.command("Trigger Command Preset", "Hooks", timeout=20)
    took = time.monotonic() - began
    sink.close()
    assert took < 1.0, f"triggering the preset took {took:.1f}s"


def if_then_else(cond, name):
    return {"command": "If", "args": [json.dumps(cond), json.dumps([set_variable(name, "yes")]),
                                      "Sequential", json.dumps([set_variable(name, "no")]),
                                      "Sequential"]}


# Saturday 17 October 2026, 15:06
WHEN = "2026-10-17 15:06:00"
CONDITIONS = [
    ("Time", "between", "00:00,23:59", "yes"),
    ("Time", "greater than", "9:00", "yes"),
    ("Time", "less than", "9:00", "no"),
    ("Time", "between", "14:00,02:00", "yes"),
    ("Time", "between", "22:00,02:00", "no"),
    ("Day", "between", "Friday,Sunday", "yes"),
    ("Day", "between", "Monday,Friday", "no"),
    ("Day", "greater than", "Monday", "yes"),
    ("Month", "between", "September,November", "yes"),
    ("Month", "between", "November,February", "no"),
    ("Month", "less than", "December", "yes"),
]


def test_if_compares_times_days_and_months_in_order(fppd):
    """If's Time, Day and Month checks order their values as times and
    positions in the week and year -- 15:06 is after 9:00, Saturday is
    between Friday and Sunday, a range that ends before it starts wraps --
    rather than as numbers or text.

    Regression: 92ddc059f. between needed numbers, so it was false for
    every time, day and month; text comparison put 15:06 before 9:00 and
    the days in alphabetical order. Also covers 71b217e47, which added the
    Day and Month sources."""
    fppd.start(fake_time=WHEN)
    got = {}
    for i, (src, cmp_, value, _) in enumerate(CONDITIONS):
        name = f"C{i}"
        fppd.post("/command", if_then_else({"source": src, "name": "", "comparator": cmp_,
                                            "value": value}, name))
        fppd.wait_for(lambda: variable(fppd, name), timeout=5, what=f"the If for {src} {cmp_} {value}")
        got[(src, cmp_, value)] = variable(fppd, name)
    wrong = {k: v for (k, v), (_, _, _, want) in zip(got.items(), CONDITIONS) if v != want}
    assert not wrong, f"wrong answers: {wrong}"


def test_listing_fpp_variables_while_a_playlist_runs_if_does_not_deadlock(fppd):
    """GET /api/variables?fpp=true, polled while a looping playlist runs If
    entries, keeps answering.

    Regression: caab3dccc. Listing the fpp_* variables held their
    change-tracking lock while reading the playlist status, which takes the
    playlist's lock; the main loop holds the playlist's lock while a command
    entry runs, and an If with an Expression lists the variables, taking the
    tracking lock. Each waited for the other and fppd hung.
    """
    import threading
    cond = expression_is("1", "1")
    fppd.write("playlists/Ifs.json", playlist(
        "Ifs", [command_entry(if_command(cond, [set_variable("Hit", 1)]))] * 20, repeat=1))
    fppd.start()
    fppd.command("Start Playlist", "Ifs", "true", "false")
    stop = time.monotonic() + 15
    errors = []

    def poll():
        try:
            while time.monotonic() < stop and not errors:
                fppd.get("/variables?fpp=true", timeout=5)
        except Exception as e:  # noqa: BLE001 -- a wedge is what we look for
            errors.append(e)

    pollers = [threading.Thread(target=poll) for _ in range(4)]
    for t in pollers:
        t.start()
    for t in pollers:
        t.join()
    assert not errors, errors[0]
    assert variable(fppd, "Hit") == "1"


@pytest.mark.parametrize("scheme", ["file", "FILE"])
def test_url_command_does_not_read_local_files(fppd, scheme):
    """The URL command fetches http and https only; a file:// URL is refused
    rather than read (as root) and handed back.

    Regression: be4b5df67. libcurl's default protocol set includes file://,
    so POST /api/command/URL with "file:///etc/shadow" returned the file."""
    marker = "fpp-tests-local-file-marker-7f3c"
    fppd.write("upload/marker.txt", marker)
    fppd.start()
    url = f"{scheme}://{os.path.join(fppd.media, 'upload', 'marker.txt')}"
    try:
        got = fppd.command("URL", url, "GET", "", timeout=15)
    except urllib.error.HTTPError as e:
        got = e.body
    assert marker not in str(got), f"the URL command read a local file: {got!r}"


def test_running_a_command_by_get_is_marked_deprecated(fppd):
    """GET /api/command/<name>/... still runs the command, and says it is
    deprecated: a Deprecation header, and one fppd.log line per command and
    client however often it is called. FPP 11 will require POST.

    Regression: c5a64f567."""
    import urllib.request
    from fppd import API
    fppd.start()
    for _ in range(3):
        with urllib.request.urlopen(API + "/command/Volume%20Set/40", timeout=10) as r:
            assert r.headers.get("Deprecation") == "true", dict(r.headers)
    log = open(os.path.join(fppd.media, "logs", "fppd.log")).read()
    lines = [l for l in log.splitlines() if "Deprecated: GET /api/command/Volume Set" in l]
    assert len(lines) == 1, lines


def test_a_url_too_long_for_libcurl_fails_on_its_own(fppd):
    """A URL command whose URL libcurl refuses (over its 8,000,000-byte
    limit; a presets file has no HTTP body limit in the way) fails, and
    fppd carries on.

    Regression: 9cc0f637c. The transfer's members had no initializers, and
    the constructor cleaned up after the rejected URL before the multi
    handle was ever set: libcurl was handed a garbage pointer and fppd
    crashed."""
    fppd.write("config/commandPresets.json", {"commands": [
        preset("Big", {"command": "URL", "args": ["http://127.0.0.1/" + "a" * 8_100_000, "GET", ""]}),
        preset("After", set_variable("After", "yes"))]})
    fppd.start(timeout=90)
    try:
        fppd.command("Trigger Command Preset", "Big", timeout=30)
    except urllib.error.HTTPError:
        pass  # refused is fine; fppd has to live
    fppd.check_alive()
    fppd.command("Trigger Command Preset", "After")
    assert variable(fppd, "After") == "yes"


def test_random_variable_over_the_whole_int_range(fppd):
    """Set Variable Random between INT_MIN and INT_MAX (a MultiSync command
    packet can ask for that) sets an int, and does no undefined arithmetic.

    Regression: 37268fa78. The span mx - mn + 1 overflowed to 0, and
    rand() % 0 raised SIGFPE on x86 (fppd died). arm64 doesn't trap, so
    there it is the UBSan build (--flavor ubsan) that shows it, in fppd's
    stdout."""
    import re
    fppd.start()
    for _ in range(5):
        fppd.command("Set Variable", "R", "Random", "", "1", "-2147483648", "2147483647", "")
        assert re.fullmatch(r"-?\d+", variable(fppd, "R")), variable(fppd, "R")
    fppd.check_alive()
    with open(os.path.join(fppd.media, "logs", "fppd.stdout"), errors="replace") as f:
        ub = [l for l in f if "VariableCommands.cpp" in l and "runtime error" in l]
    assert not ub, ub


def test_run_script_refuses_a_path_outside_the_scripts_directory(fppd):
    """Run Script with a ".." in the script's path doesn't run it, and says
    so in a warning; a script in the scripts directory still runs.

    Regression: 2494f1e34. The name was appended to the scripts directory
    and run (as root), so "../anything" ran any file on the box.
    Also d10733a39: the warning raised here needs Warnings.h, which only
    the precompiled header supplied (red on its parent with --nopch)."""
    escaped = os.path.join(fppd.media, "tmp", "escaped")
    ok = os.path.join(fppd.media, "tmp", "ok")
    for rel, marker in (("escape.sh", escaped), ("scripts/ok.sh", ok)):
        os.chmod(fppd.write(rel, f"#!/bin/bash\ntouch {marker}\n"), 0o755)
    fppd.start()
    try:
        fppd.command("Run Script", "../escape.sh", "", "")
    except urllib.error.HTTPError:
        pass
    fppd.command("Run Script", "ok.sh", "", "")
    fppd.wait_for(lambda: os.path.exists(ok), timeout=10, what="the script in scripts/ to run")
    time.sleep(3)
    assert not os.path.exists(escaped), "a script outside the scripts directory ran"
    assert any("Refused to run a script outside the scripts directory" in str(w)
               for w in fppd.get("/fppd/status").get("warnings", [])), \
        fppd.get("/fppd/status").get("warnings")


class StandInApi:
    """A stand-in for the web API on port 80, where fppd sends the requests
    some commands make of http://localhost/api/...: it records each request's
    method, path and body and answers 200 with "{}"."""

    def __init__(self):
        import http.server
        import threading
        self.requests = []
        recorded = self.requests

        class H(http.server.BaseHTTPRequestHandler):
            def handle_any(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
                recorded.append((self.command, self.path, body))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = do_POST = do_PUT = handle_any

            def log_message(self, *a):
                pass

        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), H)
        except OSError as e:
            pytest.skip(f"can't listen on port 80 for the web API stand-in: {e}")
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def api_routes(fppd, path):
    """The methods the tree's www/api/index.php dispatches `path` (under
    /api) for: the receiving end of a request fppd makes of the web API."""
    with open(os.path.join(fppd.tree, "www", "api", "index.php")) as f:
        text = f.read()
    return {m.upper() for m in re.findall(r"dispatch_(get|post|put|delete)\('" + re.escape(path) + r"'", text)}


def test_routing_preset_name_with_a_quote_is_sent_intact(fppd):
    """"Pipewire Apply Routing Preset" with a preset name containing a quote
    and a backslash sends the live-apply endpoint valid JSON naming exactly
    that preset, by a method that endpoint is routed for. In a build with
    GStreamer the command has to be there under that name.

    Regression: 03d41a751. The request body was pasted together around the
    name, so '"' or '\\' in it made invalid JSON (or a different request).
    Also 7b9766638 (the command's name; shown red against master with the
    rename reverted) and 11a5a13a6 (the command; red with its registration
    removed): this used to skip when the command wasn't listed, so it
    couldn't fail for either."""
    fppd.start()
    listed = [c["name"] for c in fppd.get("/commands")]
    if not fppd.built_with("gstreamer"):
        pytest.skip("built without GStreamer, so without the AES67/PipeWire commands")
    assert "Pipewire Apply Routing Preset" in listed, \
        sorted(n for n in listed if "Preset" in n or "Routing" in n)
    with StandInApi() as api:
        name = 'a"b\\c'
        fppd.command("Pipewire Apply Routing Preset", name, timeout=15)
        fppd.wait_for(lambda: api.requests, timeout=10, what="the live-apply request")
    method, path, body = api.requests[0]
    assert path == "/api/pipewire/audio/routing/presets/live-apply", api.requests
    assert method in api_routes(fppd, "/pipewire/audio/routing/presets/live-apply"), \
        f"{method} isn't routed for the live-apply endpoint"
    assert json.loads(body)["name"] == name, body


def test_persisted_variable_saves_land_in_order(fppd):
    """Two persisted Set Variable commands, the first one's save held up at
    the file lock, leave the later value on disk.

    Regression: 4a1d2280a. A save snapshotted the variables under the lock
    and wrote them after releasing it, so a slow earlier save could write
    its stale snapshot over a later one: here "old" ended up on disk
    though "new" was set last (slowflock.so holds up the first write)."""
    import threading
    import shims
    flag = os.path.join(fppd.media, "tmp", "slowflock")
    fppd.start(preload=[shims.build("slowflock.c")],
               extra_env={"SLOWFLOCK_SUFFIX": "/config/variables.json", "SLOWFLOCK_FLAG": flag})
    open(flag, "w").close()

    def persist(value):
        fppd.command("Set Variable", "X", "Value", value, "1", "0", "100", "", "true", timeout=15)

    a = threading.Thread(target=persist, args=("old",))
    a.start()
    time.sleep(0.3)
    persist("new")
    a.join(15)
    assert not os.path.exists(flag), "the first save never reached its file lock"
    time.sleep(2)
    with open(os.path.join(fppd.media, "config", "variables.json")) as f:
        saved = json.load(f)
    assert saved["X"]["value"] == "new", saved


def flock_waiting_behind(holder_fd):
    """Whether some other process's flock(LOCK_EX) is queued on the file
    `holder_fd` (ours, holding LOCK_SH) is open on: /proc/locks lists a
    blocked request as "-> FLOCK ... WRITE" on the same dev:inode as the
    lock it waits for."""
    st = os.fstat(holder_fd)
    node = f"{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino} "
    with open("/proc/locks") as f:
        lines = f.read().splitlines()
    return any("->" in l and "FLOCK" in l and "WRITE" in l and node in l for l in lines)


def test_a_file_save_never_shows_a_locked_reader_an_empty_file(fppd):
    """While a reader holds a shared flock on a file fppd saves through
    PutFileContents() (here a persisted Set Variable rewriting
    config/variables.json), the file keeps its old contents: fppd's save
    waits at the lock and only then truncates and writes it.

    Regression: 8ffe7f0b1. PutFileContents() opened the file with
    fopen("w"), which empties it, and only then asked for LOCK_EX, so a
    reader holding LOCK_SH -- PHP's settings reads, for the settings file
    -- read it empty: every setting missing, and the UI sent to the setup
    wizard."""
    import fcntl
    import threading
    fppd.start()

    def persist(value):
        fppd.command("Set Variable", "X", "Value", value, "1", "0", "100", "", "true", timeout=20)

    path = os.path.join(fppd.media, "config", "variables.json")
    persist("old")
    with open(path) as f:
        before = f.read()
    assert json.loads(before)["X"]["value"] == "old", before

    fd = os.open(path, os.O_RDONLY)
    errors = []
    try:
        fcntl.flock(fd, fcntl.LOCK_SH)

        def save():
            try:
                persist("new")
            except Exception as e:  # reported below, after the lock is let go
                errors.append(e)

        saver = threading.Thread(target=save)
        saver.start()
        # The control: fppd's save has reached the file and is waiting for
        # our lock, so whatever it does to the file before locking is done.
        fppd.wait_for(lambda: flock_waiting_behind(fd), timeout=10,
                      what="fppd's save to wait for the file lock")
        with open(path) as f:
            during = f.read()
    finally:
        os.close(fd)  # drops the lock
    saver.join(20)
    assert not saver.is_alive(), "the save never finished after the lock was released"
    assert not errors, errors
    assert during == before, f"while the reader held its lock the file read {during!r}"
    with open(path) as f:
        assert json.load(f)["X"]["value"] == "new"


def test_the_insert_playlist_commands_are_basic(fppd):
    """Insert Playlist After Current and Insert Playlist Immediate are listed
    at the Basic UI level (0), so the command editor offers them without
    Advanced turned on.

    Regression: 291a7cf12. Both were registered at level 1 (Advanced)."""
    fppd.start()
    levels = {c["name"]: c.get("level") for c in fppd.get("/commands")}
    for name in ("Insert Playlist After Current", "Insert Playlist Immediate"):
        assert levels.get(name) == 0, f"{name}: level {levels.get(name)!r}"


def test_an_if_skips_command_list_entries_that_are_not_objects(fppd):
    """An If whose Then list holds entries that aren't JSON objects -- a
    number, a string -- skips them and runs the commands after them, whether
    the If is POSTed or runs as a playlist entry; the playlist goes on.

    Regression: 113f5372a. Each entry was read with Json::Value::get(),
    which throws Json::LogicError on a non-object: the whole If failed
    (POSTed, a 500), and none of its commands ran."""
    fppd.start()
    fppd.command("Set Variable", "Flag", "Value", "1", "1", "0", "100", "")
    cmd = if_command(expression_is("Flag", "1"), [42, "Set Variable", set_variable("Posted", "yes")])
    try:
        fppd.post("/command", cmd)
    except urllib.error.HTTPError as e:
        pytest.fail(f"the If was refused: {e.code} {getattr(e, 'body', '')}")
    fppd.wait_for(lambda: variable(fppd, "Posted") == "yes", timeout=5,
                  what="the If's command after the non-object entries to run")

    fppd.write("playlists/Ifs.json", playlist("Ifs", [
        command_entry(if_command(expression_is("Flag", "1"), [7, set_variable("FromEntry", "yes")])),
        command_entry(set_variable("After", "yes"))]))
    fppd.command("Start Playlist", "Ifs", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "After") == "yes", timeout=10,
                  what="the entry after the If to run")
    assert variable(fppd, "FromEntry") == "yes", "the playlist entry's If didn't run its command"


def test_variables_reach_a_playlist_command_entry(fppd):
    """%VAR:name% in a playlist "FPP Command" entry's arguments is replaced
    with the variable's value when the entry runs, as it is for presets.

    Regression: ce9700595. Only the preset path (ReplaceCommandKeywords)
    substituted variables; a playlist entry runs its command through
    CommandManager::run() directly, so the command got the literal
    "%VAR:Src%"."""
    fppd.write("playlists/Vars.json", playlist("Vars", [
        command_entry(set_variable("Dst", "%VAR:Src%")),
        command_entry(set_variable("Done", "yes"))]))
    fppd.start()
    fppd.command("Set Variable", "Src", "Value", "seven", "1", "0", "100", "")
    fppd.command("Start Playlist", "Vars", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "Done") == "yes", timeout=10, what="the playlist to run")
    assert variable(fppd, "Dst") == "seven"


@pytest.mark.parametrize("name, path", [("Reboot", "/system/reboot"), ("Shutdown", "/system/shutdown")])
def test_reboot_and_shutdown_commands_need_confirming(fppd, name, path):
    """The Reboot and Shutdown commands (System, Advanced) refuse to act
    without their confirm argument, and with it ask the web API's
    /api/system/reboot or /shutdown -- by a method that route is dispatched
    for -- to do it. On a player, not in a container: the image's
    /etc/fpp/container is hidden from fppd (nocontainer.c), and port 80 is
    a stand-in that only records the request.

    Regression: 675ddc7f4, which added them. Its parent has neither command."""
    from shims import build
    fppd.start(preload=[build("nocontainer.c")])
    listed = {c["name"]: c for c in fppd.get("/commands")}
    assert name in listed, f"no {name} command"
    assert listed[name].get("category") == "System" and listed[name].get("level") == 1, listed[name]
    with StandInApi() as api:
        for refused in ("false", "0"):
            try:
                result = fppd.command(name, refused)
            except urllib.error.HTTPError as e:
                result = getattr(e, "body", "")
            assert "Confirmation not given" in str(result), result
        time.sleep(1)
        assert api.requests == [], "an unconfirmed command reached the API"
        fppd.command(name, "true")
        fppd.wait_for(lambda: api.requests, timeout=10, what=f"the {name} request")
    method, req_path, _ = api.requests[0]
    assert req_path == "/api" + path, api.requests
    assert method in api_routes(fppd, path), f"{method} isn't routed for /api{path}"
    fppd.check_alive()


def test_the_remote_commands_are_gone(fppd):
    """The deprecated Remote ... commands, which posted a command to one
    other player by address, aren't listed; a playlist entry naming one
    fails on its own and the playlist runs its next entry.

    Regression: 58087f2ed, which removed them in favour of MultiSync
    commands (shown red against master with the removal reverted). The
    upgrade that converts saved ones is tested separately."""
    fppd.start()
    listed = [c["name"] for c in fppd.get("/commands")]
    assert not [n for n in listed if n.startswith("Remote ")], [n for n in listed if "Remote" in n]
    fppd.write("playlists/Old.json", playlist("Old", [
        command_entry({"command": "Remote Trigger Command Preset", "args": ["127.0.0.2", "Nothing"]}),
        command_entry(set_variable("After", "yes"))]))
    fppd.command("Start Playlist", "Old", "false", "false")
    fppd.wait_for(lambda: variable(fppd, "After") == "yes", timeout=10,
                  what="the entry after the Remote command to run")


def test_the_aes67_self_test(fppd):
    """The "AES67 Test" command and fppd's /aes67/test route answer with a
    result per subsystem check and a summary that adds up, and the tree's
    scripts/aes67_test --self-test, which reads that route, prints them;
    fppd stays up.

    Regression: 28d36cfc0, which added both (shown red against master with
    the command and route removed). The zero-hop inline RTP it also added is
    gone from master."""
    import subprocess
    fppd.start()
    if not fppd.built_with("gstreamer"):
        pytest.skip("built without GStreamer, so without AES67")
    assert "AES67 Test" in [c["name"] for c in fppd.get("/commands")]
    try:
        report = str(fppd.command("AES67 Test", timeout=30))
    except urllib.error.HTTPError as e:
        report = getattr(e, "body", "")  # an ErrorResult when a check fails
    assert "gstreamer_init" in report and re.search(r"Total: \d+ \| Passed: \d+ \| Failed: \d+", report), report
    result = fppd.get("/aes67/test", timeout=30)
    tests, summary = result["tests"], result["summary"]
    assert tests and all({"test", "passed", "message"} <= set(t) for t in tests), result
    passed = sum(1 for t in tests if t["passed"])
    assert (summary["total"], summary["passed"], summary["failed"]) == \
        (len(tests), passed, len(tests) - passed), result
    assert summary["allPassed"] == (passed == len(tests))
    assert {"test": "gstreamer_init", "passed": True} == \
        {k: v for k, v in next(t for t in tests if t["test"] == "gstreamer_init").items() if k != "message"}
    script = os.path.join(fppd.tree, "scripts", "aes67_test")
    out = subprocess.run(["bash", script, "--self-test"], capture_output=True, text=True, timeout=60).stdout
    assert f"Total: {summary['total']} | Passed: {passed} | Failed: {len(tests) - passed}" in out, out
    fppd.check_alive()
