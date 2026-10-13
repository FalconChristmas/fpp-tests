"""Config files with values of the wrong JSON type.

jsoncpp throws Json::LogicError from asInt()/asString()/operator[] on a
value of the wrong type, and a loader with nothing to catch it takes fppd
down -- at startup, so with the file saved, fppd crash loops. These are
files a user can hand-edit or an API can write: a number saved as a string,
null for a missing value, a list where one entry was meant.

Each case writes one file, starts fppd, pokes the path that reads the file
if it is not read at startup, and expects fppd to keep running -- and, for
the saved stream-slot volumes, read as a stream starts, the Play Media that
started it to succeed rather than fail on the throw. (Output,
model, preset, playlist and schedule configs are covered elsewhere.)

Regression: c235addbd. Every case but the xlights-* ones terminated fppd
before it, and the stream-slot ones failed Play Media; the xlights-* ones
already passed and are kept as coverage.
"""

import os
import time
import urllib.error

import pytest

from audio import write_tone_wav

S = "1"   # a number written as a string
L = [1]   # a list where a scalar belongs
O = {"a": 1}

CASES = {
    # e131bridge LoadInputUniversesFromFile / BridgeReloadDMXInputs
    "ci-universes: channelInputs is an object": ("ci-universes.json", {"channelInputs": {"x": 1}}),
    "ci-universes: entry is a string": ("ci-universes.json", {"channelInputs": ["x"]}),
    "ci-universes: enabled as a string": ("ci-universes.json", {"channelInputs": [
        {"type": "universes", "enabled": S, "universes": []}]}),
    "ci-universes: universe fields as strings": ("ci-universes.json", {"channelInputs": [
        {"type": "universes", "enabled": 1, "timeout": "x", "universes": [
            {"active": S, "id": S, "startChannel": S, "channelCount": L, "type": O, "priority": S}]}]}),
    "ci-dmx: fields of the wrong type": ("ci-dmx.json", {"channelInputs": [
        {"type": "dmx", "enabled": "true", "startAddress": S, "channelCount": L, "device": O}]}),
    "ci-dmx: entry is a list": ("ci-dmx.json", {"channelInputs": [[1]]}),
    # Variables::load
    "variables: value is a number": ("variables.json", {"myVar": 5}),
    "variables: fields of the wrong type": ("variables.json", {"v": {"value": L, "persist": "true",
                                                                     "lastUpdated": "x"}}),
    # Sensors
    "sensors: sensors is an object": ("sensors.json", {"sensors": {"a": 1}}),
    "sensors: fields of the wrong type": ("sensors.json", {"sensors": [
        {"type": "sensor", "label": L, "precision": S, "scale": S, "channel": S, "sensor": O}]}),
    # RecurringTasks::load
    "recurringtasks: entry is a string": ("recurringtasks.json", ["x"]),
    "recurringtasks: fields of the wrong type": ("recurringtasks.json", [
        {"name": L, "enabled": "true", "intervalMS": "60000", "type": O, "persistResult": "no"}]),
    # GPIO inputs (the pin is unknown here, so only the first fields are read)
    "gpio: entry is a number": ("gpio.json", [5]),
    "gpio: fields of the wrong type": ("gpio.json", [{"pin": L, "enabled": "true", "mode": O}]),
    # channeloutputs.json subType, outside the per-output try
    "channeloutputs: subType is a list": ("channeloutputs.json", {"channelOutputs": [
        {"type": "LEDPanelMatrix", "subType": L, "enabled": 1, "startChannel": 1, "channelCount": 3072}]}),
    # read when a model name isn't found
    "xlights-submodels: submodels is an object": ("xlights-submodels.json", {"submodels": {"a": 1}}),
    "xlights-submodels: entry is a string": ("xlights-submodels.json", {"submodels": ["x", {"Name": L}]}),
    "xlights-modelgroups: entry is a number": ("xlights-modelgroups.json", {"modelgroups": [5]}),
    # read at startup by setVolume() under a PipeWire backend
    "pipewire-audio-groups: root is a list": ("pipewire-audio-groups.json", [1, 2]),
    "pipewire-audio-groups: fields of the wrong type": ("pipewire-audio-groups.json", {"groups": [
        {"id": S, "enabled": "true", "members": [{"cardId": L, "nodeTarget": O, "delayMs": S, "channels": S}]}]}),
    "pipewire-opus-rtp: root is a list": ("pipewire-opus-rtp-instances.json", [1]),
    "pipewire-opus-rtp: fields of the wrong type": ("pipewire-opus-rtp-instances.json", {"instances": [
        {"id": S, "enabled": "true", "mode": L, "name": O, "port": S}]}),
    "pipewire-stream-slots: slots of the wrong type": ("pipewire-stream-slots.json", {"slots": {"1": "75"}}),
    "pipewire-stream-slots: root is a list": ("pipewire-stream-slots.json", [1]),
}


def poke(fppd, name):
    """Run the code that reads `name` if startup doesn't."""
    def get(path):
        try:
            fppd.get(path, timeout=10)
        except urllib.error.HTTPError:
            pass
    if name.startswith("xlights-"):
        get("/models/NoSuchModel")
        get("/models?submodels=true")
    if name.startswith("pipewire-"):
        try:
            fppd.post("/fppd/volume/50", timeout=10)
        except urllib.error.HTTPError:
            pass
        write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 2)
        if "stream-slots" in name:
            # read as the stream starts: a throw there fails the command
            fppd.command("Play Media", "Tone.wav", "1", "0", "1")
        else:
            try:
                fppd.command("Play Media", "Tone.wav", "1", "0", "1")
            except urllib.error.HTTPError:
                pass  # no PipeWire here; the group configs are read on the way
        time.sleep(1)
    if name == "recurringtasks.json":
        try:
            fppd.post("/fppd/recurringtasks", {"command": "reload"}, timeout=10)
        except urllib.error.HTTPError:
            pass


@pytest.mark.parametrize("what", list(CASES))
def test_wrong_typed_config_is_survived(fppd, request, what):
    name, content = CASES[what]
    fppd.write(f"config/{name}", content)
    if "stream-slots" in name:
        # the saved slot volume is read once a stream is playing
        request.getfixturevalue("audio")
    elif name.startswith("pipewire-"):
        fppd.settings(MediaBackend="pipewire")
    if name.startswith("xlights-modelgroups"):
        fppd.write("config/xlights-submodels.json", {"submodels": []})
    fppd.start()
    poke(fppd, name)
    time.sleep(0.5)
    fppd.get("/fppd/status", timeout=10)
