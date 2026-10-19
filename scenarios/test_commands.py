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
