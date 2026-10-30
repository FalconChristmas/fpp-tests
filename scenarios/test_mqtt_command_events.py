"""The command/run and command/preset/triggered topics fppd publishes when a
command runs or a preset fires, seen by a mosquitto_sub on a local broker
(test_mqtt_control's)."""

import json
import shutil
import subprocess
import time
import urllib.parse

import pytest

from show import status
from test_mqtt_control import HOST, PORT, broker, publish


def subscribe(seconds):
    """Every message under fppd's command/ topics for `seconds`, with the
    payload in hex so a multi-line JSON payload stays on one line."""
    if not shutil.which("mosquitto_sub"):
        pytest.skip("mosquitto_sub is not installed")
    return subprocess.Popen(
        ["mosquitto_sub", "-h", "127.0.0.1", "-p", PORT, "-q", "1", "-W", str(seconds),
         "-F", "%t %r %x", "-t", f"falcon/player/{HOST}/command/#"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)


def messages(proc):
    """(sub-topic, payload) of each live (not retained) message."""
    out, _ = proc.communicate(timeout=60)
    prefix = f"falcon/player/{HOST}/"
    got = []
    for line in out.splitlines():
        topic, retained, payload = (line.split(" ", 2) + ["", ""])[:3]
        if retained != "0":
            continue
        try:
            body = json.loads(bytes.fromhex(payload).decode())
        except ValueError:
            body = bytes.fromhex(payload).decode(errors="replace")
        got.append((topic[len(prefix):], body))
    return got


def set_variable(name, value):
    return {"command": "Set Variable", "args": [name, "Value", str(value), "1", "0", "100", ""]}


def runs(got, name):
    """The command/run payloads that set variable `name`."""
    return [b for t, b in got if t == "command/run" and isinstance(b, dict)
            and b.get("command") == "Set Variable" and (b.get("args") or [None])[0] == name]


def connected(fppd):
    fppd.settings(MQTTHost="127.0.0.1", MQTTPort=PORT, HostName=HOST)
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("MQTT", {}).get("connected"), timeout=20,
                  what="fppd to connect to the broker")


def test_each_command_route_publishes_command_run_with_its_trigger(fppd):
    """A command run through POST /api/command (a JSON command, the way the
    UI and presets run them), GET /api/command/<name>/<args> and POST
    /api/command/<name> with an argument array each publishes one
    command/run message with the command, its arguments, and where it came
    from: "ui", "api-get" and "api-post".

    Regression: 6463318a4, which added command/run to these three routes
    (b4835d150 had added it only to the internal one), and 257ffa064, which
    added "trigger"."""
    with broker():
        connected(fppd)
        live = subscribe(6)
        time.sleep(1)
        fppd.post("/command", set_variable("ViaJson", 1))
        path = "/".join(urllib.parse.quote(a) for a in ["Set Variable", "ViaGet", "Value", "2", "1", "0", "100"])
        fppd.get("/command/" + path)
        fppd.post("/command/" + urllib.parse.quote("Set Variable"),
                  ["ViaPost", "Value", "3", "1", "0", "100", ""])
        got = messages(live)
    for name, value, trigger in (("ViaJson", "1", "ui"), ("ViaGet", "2", "api-get"),
                                 ("ViaPost", "3", "api-post")):
        seen = runs(got, name)
        assert len(seen) == 1, f"{name}: {len(seen)} command/run messages, not 1: {got}"
        assert seen[0]["args"][:3] == [name, "Value", value], seen[0]
        assert seen[0].get("trigger") == trigger, f"{name}: {seen[0]}"


def test_internal_commands_and_preset_triggers_are_published(fppd):
    """A command run inside fppd (here from an MQTT set/command topic, which
    calls CommandManager::run with plain arguments) publishes command/run
    with trigger "internal"; triggering a preset by name publishes
    command/preset/triggered with its name, and by slot with its slot.

    Regression: b4835d150, which added both topics, and 257ffa064, which
    added "trigger"."""
    fppd.write("config/commandPresets.json", {"commands": [
        dict(set_variable("ByName", 1), name="Named", presetSlot=0),
        dict(set_variable("BySlot", 1), name="Slotted", presetSlot=7)]})
    with broker():
        connected(fppd)
        live = subscribe(8)
        time.sleep(1)
        publish("set/command/Set Variable/ViaMqtt/Value/4/1/0/100")
        fppd.wait_for(lambda: str(fppd.get("/variables/ViaMqtt")) == "4", timeout=5,
                      what="the MQTT command to run")
        fppd.command("Trigger Command Preset", "Named")
        fppd.command("Trigger Command Preset Slot", "7")
        got = messages(live)
    seen = runs(got, "ViaMqtt")
    assert len(seen) == 1, f"{len(seen)} command/run messages for the MQTT command, not 1: {got}"
    assert seen[0]["args"][:3] == ["ViaMqtt", "Value", "4"], seen[0]
    assert seen[0].get("trigger") == "internal", seen[0]
    presets = [b for t, b in got if t == "command/preset/triggered"]
    assert {"preset": "Named"} in presets, f"no preset/triggered for the named preset: {got}"
    assert {"slot": 7} in presets, f"no preset/triggered for slot 7: {got}"
