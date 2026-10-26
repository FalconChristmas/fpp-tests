"""Command lists that name a Command Preset (Trigger Command Preset) rather
than holding a copy of its command, as the command editor now saves a preset
picked for an If's Then Run list or a GPIO input's edge, and an If whose
Check reads one of fppd's read-only status variables.

The page halves are web/tests/command-editor.spec.ts and
web/tests/gpio-command-cards.spec.ts; these are fppd's side of the same JSON.
"""

import json
import os
import time

from test_conditions import TRUE, leaf, set_variable, variable

PRESET = "fpp-tests ref"
VAR = "RefValue"


def presets(value):
    return {"commands": [{"name": PRESET, "presetSlot": 0, **set_variable(VAR, value)}]}


def reference():
    """What the editor saves for the preset now (594b7fcd7)."""
    return {"command": "Trigger Command Preset", "args": [PRESET]}


def rewrite_presets(fppd, value):
    """Change the preset on disk, and wait for fppd's file monitor to load it."""
    fppd.write("config/commandPresets.json", presets(value))
    fppd.wait_for(lambda: any(c.get("args", [None, None, None])[2] == value
                              for c in fppd.get("/commandPresets").get("commands", [])),
                  timeout=10, what=f"fppd to reload the preset with {value}")


def test_an_if_then_list_reference_runs_the_preset_as_it_is_when_the_if_runs(fppd):
    """An If whose Then Run list is a Trigger Command Preset runs the preset
    as it stands each time: after the preset is changed, the same If sets
    the variable to the preset's new value.

    Receiving end of 594b7fcd7 (the fix is in the command editor, which
    used to save a copy of the preset's command): fppd's handling of the
    reference is unchanged by it.  The control is the copy the editor saved
    before, which keeps the old value.
    """
    fppd.write("config/commandPresets.json", presets("first"))
    fppd.start()
    run_if = lambda then: fppd.post("/command", {"command": "If", "args": [
        json.dumps(TRUE), json.dumps([then]), "Sequential", "", "Sequential"]})
    copy = set_variable(VAR, "first")

    run_if(reference())
    fppd.wait_for(lambda: variable(fppd, VAR) == "first", timeout=5, what="the If to run the preset")
    rewrite_presets(fppd, "second")
    run_if(reference())
    fppd.wait_for(lambda: variable(fppd, VAR) == "second", timeout=5, what="the If to run the changed preset")

    run_if(copy)
    fppd.wait_for(lambda: variable(fppd, VAR) == "first", timeout=5, what="the copied command")


def test_a_gpio_edge_reference_runs_the_preset_as_it_is_when_the_input_fires(fppd):
    """A gpio.json input whose rising edge is a Trigger Command Preset runs
    the preset as it stands when the input fires.  The input is one of
    fppd's TF-n test pins, high while /tmp/GPIO-TF-n exists.

    Receiving end of 594b7fcd7, the GPIO half: gpio.php now saves the
    reference rather than a copy of the preset's command.
    """
    pin, flag = "TF-7", "/tmp/GPIO-TF-7"
    if os.path.exists(flag):
        os.unlink(flag)
    fppd.write("config/commandPresets.json", presets("first"))
    fppd.write("config/gpio.json", [{
        "pin": pin, "enabled": True, "mode": "gpio", "desc": "ref", "debounceTime": 10, "debounceEdge": "both",
        "rising": [reference()], "falling": [], "holdTime": 0, "hold": []}])
    fppd.start()
    try:
        def fire():
            open(flag, "w").close()
            fppd.wait_for(lambda: variable(fppd, VAR) != "", timeout=10, what="the rising edge to run its command")
            os.unlink(flag)

        fire()
        assert variable(fppd, VAR) == "first"
        fppd.command("Set Variable", VAR, "Value", "", "1", "0", "100", "")
        rewrite_presets(fppd, "second")
        # Let the input see the line low before it goes high again.
        time.sleep(0.5)
        fire()
        assert variable(fppd, VAR) == "second"
    finally:
        if os.path.exists(flag):
            os.unlink(flag)


def test_an_if_formula_can_read_fppd_status_variables(fppd):
    """An If whose Check is a formula over one of fppd's read-only status
    variables (fpp_uptime_seconds) evaluates it at runtime, as the editor's
    validation already did.

    Regression: bb2173530 (Condition.cpp).  The formula bound only the
    user's own variables, so the status variable was unbound: the editor
    showed the expression valid, and the If took Otherwise.
    """
    fppd.start()
    name = "StatusIf"
    cond = leaf("fpp_uptime_seconds + 1", "greater than", "0")
    fppd.post("/command", {"command": "If", "args": [
        json.dumps(cond), json.dumps([set_variable(name, "yes")]), "Sequential",
        json.dumps([set_variable(name, "no")]), "Sequential"]})
    fppd.wait_for(lambda: variable(fppd, name), timeout=5, what="the If on a status variable")
    assert variable(fppd, name) == "yes"
    # And the editor's own check of the expression agrees.
    v = fppd.get("/variables?validateExpression=" + "fpp_uptime_seconds%20%2B%201")
    assert v.get("valid") is True, v
