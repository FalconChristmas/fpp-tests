"""Commands: what fppd does with malformed or hostile command input, from the
places that run commands without an HTTP handler above them."""

import json
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
