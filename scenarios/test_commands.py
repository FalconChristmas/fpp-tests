"""Commands: what fppd does with malformed or hostile command input, from the
places that run commands without an HTTP handler above them."""

import json
import os
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
    the days in alphabetical order."""
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
    and run (as root), so "../anything" ran any file on the box."""
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


def test_routing_preset_name_with_a_quote_is_sent_intact(fppd):
    """"Pipewire Apply Routing Preset" with a preset name containing a quote
    and a backslash sends the live-apply endpoint valid JSON naming exactly
    that preset.

    Regression: 03d41a751. The request body was pasted together around the
    name, so '"' or '\\' in it made invalid JSON (or a different request)."""
    import http.server
    import threading
    bodies = []

    class H(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            bodies.append(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    fppd.start()
    if "Pipewire Apply Routing Preset" not in [c["name"] for c in fppd.get("/commands")]:
        pytest.skip("built without AES67 GStreamer support")
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), H)
    except OSError as e:
        pytest.skip(f"can't listen on port 80 for the live-apply endpoint: {e}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        name = 'a"b\\c'
        fppd.command("Pipewire Apply Routing Preset", name, timeout=15)
        fppd.wait_for(lambda: bodies, timeout=10, what="the live-apply request")
    finally:
        server.shutdown()
        server.server_close()
    assert json.loads(bodies[0])["name"] == name, bodies[0]


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
