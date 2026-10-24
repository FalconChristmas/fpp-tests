"""Channel outputs refusing a config they can't run with a warning, and
those warnings' ids: each one in /api/fppd/status warningInfo with the id
the UI looks its help text up by (www/warnings-definitions.json and the
page www/help/warning-helpers/warning-<id>.md in the tree under test)."""

import json
import os

import pytest

import shims

GONE = "fpp-tests-output.invalid"


def wanted(fppd, want):
    """The (id, text) pairs of `want` that warningInfo has no warning for:
    one with that id whose message contains that text."""
    info = fppd.get("/fppd/status").get("warningInfo", [])
    return [(wid, text) for wid, text in want
            if not any(w.get("id") == wid and text in w.get("message", "") for w in info)]


def wait_for_warnings(fppd, want, timeout=15):
    """Every (id, text) of `want` comes up; the failure names the ones that
    never did, with the warnings fppd has up instead."""
    try:
        fppd.wait_for(lambda: not wanted(fppd, want), timeout=timeout, interval=0.5,
                      what="the warnings")
    except TimeoutError:
        info = fppd.get("/fppd/status").get("warningInfo", [])
        have = [(w.get("id"), w.get("message")) for w in info]
        raise AssertionError(f"no warning {wanted(fppd, want)} among {have}") from None


def missing_help(fppd, ids):
    """The ids of `ids` the tree has no help for: no entry in
    warnings-definitions.json, or no warning-<id>.md page."""
    www = os.path.join(fppd.tree, "www")
    with open(os.path.join(www, "warnings-definitions.json")) as f:
        defined = {w.get("id") for w in json.load(f).get("Warnings", [])}
    return [i for i in ids if i not in defined or
            not os.path.exists(os.path.join(www, "help", "warning-helpers", f"warning-{i}.md"))]


def test_output_config_errors_carry_their_warning_ids(fppd):
    """A universe to a host name that doesn't resolve (14), an output type
    fppd has no plugin for (26) and a DMX-Pro of 600 channels, cut to 512
    (28), each raise their warning with its id, as does the scheduler being
    disabled (19); every one of those ids has its help text.

    Regression: 473d674d5. These warnings were raised with the id-less
    AddWarning(), so warningInfo gave them no id (0) and the UI had no help
    to show for them; none of these ids had a help page either.
    """
    fppd.write("config/co-universes.json", {"channelOutputs": [{
        "type": "universes", "enabled": 1, "startChannel": 1, "channelCount": 510,
        "universes": [{"active": 1, "description": "", "id": 1, "startChannel": 1,
                       "size": 510, "type": 1, "address": GONE, "priority": 0,
                       "monitor": 0, "deDuplicate": 0, "channelCount": 510}]}]})
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"type": "NoSuchOutput", "enabled": 1, "startChannel": 1, "channelCount": 3},
        {"type": "DMX-Pro", "enabled": 1, "startChannel": 1, "channelCount": 600,
         "device": "ttyUSB99"}]})
    fppd.settings(DisableScheduler="1")
    fppd.start(preload=[shims.build("countgai.c")],
               extra_env={"COUNTGAI_NAME": GONE,
                          "COUNTGAI_FILE": os.path.join(fppd.media, "tmp", "countgai.log")})
    wait_for_warnings(fppd, [
        (14, f"Could not resolve host name {GONE}"),
        (26, "Could not create output type NoSuchOutput"),
        (28, "exceeds the DMX universe size of 512"),
        (19, "FPP Scheduler is disabled")])
    assert not missing_help(fppd, [14, 19, 26, 28]), f"no help for {missing_help(fppd, [14, 19, 26, 28])}"


def test_display_and_serial_output_failures_raise_warnings(fppd):
    """An HTTP Virtual Display with no map file (41, and 37: its preview is
    unavailable), a Virtual Display on a model that doesn't exist (35) and a
    serial output on a device that isn't a serial port (/dev/null, 38) each
    raise a warning with its id, and every one of those ids has its help
    text.

    Regression: 6080950fc. Each of these failures was only logged: the
    displays showed just the loader's generic "Could not initialize output
    type" (26), which says nothing of the cause, the serial port nothing at
    all, and none of these ids existed.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"type": "HTTPVirtualDisplay", "enabled": 1, "startChannel": 1, "channelCount": 3,
         "width": -1, "height": -1, "pixelSize": 1, "colorOrder": "RGB", "port": 32328},
        {"type": "VirtualDisplay", "enabled": 1, "startChannel": 1, "channelCount": 3,
         "modelName": "No Such Model", "invert": False, "flipHorizontal": False,
         "device": "", "width": 64, "height": 32, "pixelSize": 1},
        {"type": "DMX-Pro", "enabled": 1, "startChannel": 1, "channelCount": 16,
         "device": "null"}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    wait_for_warnings(fppd, [
        (41, "Virtual Display map file is missing"),
        (37, "Virtual Display preview: could not initialize pixel map"),
        (35, "Invalid Pixel Overlay Model: 'No Such Model'"),
        (38, "/dev/null: could not set serial port to exclusive mode")])
    assert not missing_help(fppd, [35, 37, 38, 41]), f"no help for {missing_help(fppd, [35, 37, 38, 41])}"


def test_matrix_gpio_and_serial_config_errors_carry_their_warning_ids(fppd):
    """A Virtual Matrix and a Model Pixel Strings output on a model that
    doesn't exist (35), a GPIO output on a pin the board doesn't have (51)
    and a serial output with no device (26) each raise their warning with
    its id, and every one of those ids has its help text.

    Regression: cddde95d6. These were raised with the id-less AddWarning()
    (warningInfo id 0), and warning 51 had no help page.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [
        {"type": "VirtualMatrix", "enabled": 1, "startChannel": 1, "channelCount": 3,
         "modelName": "No Such Matrix", "width": 16, "height": 8, "invert": 0},
        {"type": "ModelPixelStrings", "enabled": 1, "startChannel": 1, "channelCount": 3,
         "modelName": "No Such Strings"},
        {"type": "GPIO", "enabled": 1, "startChannel": 1, "channelCount": 1,
         "pin": "P9-99", "invert": 0, "pwm": 0},
        {"type": "DMX-Pro", "enabled": 1, "startChannel": 1, "channelCount": 16}]})
    fppd.settings(DisableFakeNetworkBridges="1")
    fppd.start()
    wait_for_warnings(fppd, [
        (35, "VirtualMatrix: Invalid Pixel Overlay Model: No Such Matrix"),
        (35, "ModelPixelStringsOutput: Invalid Pixel Overlay Model: No Such Strings"),
        (51, "GPIO Pin 'P9-99' not found"),
        (26, "SerialChannelOutput: Invalid Config.  Unknown device.")])
    assert not missing_help(fppd, [26, 35, 51]), f"no help for {missing_help(fppd, [26, 35, 51])}"


@pytest.mark.parametrize("pin", [{"pin": "P9-99"}, {"gpio": 9999}], ids=["by-name", "by-number"])
def test_a_gpio_output_on_a_missing_pin_is_refused_with_a_warning(fppd, pin):
    """A GPIO output naming a pin this board doesn't have, by name or by
    GPIO number, fails its Init() with a warning naming the pin, and fppd
    carries on.

    Regression: ac263493a. The by-number path pushed the missing pin's name
    onto the used-pins list before checking it, a null dereference (SIGSEGV)
    as the output loaded at startup; the by-name path only logged "GPIO Pin
    not configured", with no warning.
    """
    fppd.write("config/co-other.json", {"channelOutputs": [dict({
        "type": "GPIO", "enabled": 1, "startChannel": 1, "channelCount": 1,
        "invert": 0, "pwm": 0}, **pin)]})
    fppd.start()
    text = "GPIO Pin 'P9-99' not found" if "pin" in pin else "GPIO 9999 not found"
    fppd.wait_for(lambda: any(text in w for w in fppd.get("/fppd/status").get("warnings", [])),
                  timeout=10, what=f"the {text!r} warning")
    fppd.check_alive()
