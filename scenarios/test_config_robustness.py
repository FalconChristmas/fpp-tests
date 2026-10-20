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

Regression: c235addbd. Every case terminated fppd before it, and the
stream-slot ones failed Play Media.
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
    # read at startup by setVolume() under a PipeWire backend
    "pipewire-audio-groups: root is a list": ("pipewire-audio-groups.json", [1, 2]),
    "pipewire-audio-groups: fields of the wrong type": ("pipewire-audio-groups.json", {"groups": [
        {"id": S, "enabled": "true", "members": [{"cardId": L, "nodeTarget": O, "delayMs": S, "channels": S}]}]}),
    "pipewire-opus-rtp: root is a list": ("pipewire-opus-rtp-instances.json", [1]),
    "pipewire-opus-rtp: fields of the wrong type": ("pipewire-opus-rtp-instances.json", {"instances": [
        {"id": S, "enabled": "true", "mode": L, "name": O, "port": S}]}),
    # read at startup under MediaBackend pipewire (7f890cb38)
    "pipewire-aes67: root is a list": ("pipewire-aes67-instances.json", [1]),
    "pipewire-aes67: fields of the wrong type": ("pipewire-aes67-instances.json", {
        "ptpEnabled": "yes", "ptpDomain": L, "instances": [
            {"id": S, "enabled": "true", "mode": L, "name": O, "port": S, "channels": "2",
             "multicastIP": 5, "latency": O, "sapEnabled": "no", "ptime": L}]}),
    "pipewire-stream-slots: slots of the wrong type": ("pipewire-stream-slots.json", {"slots": {"1": "75"}}),
    "pipewire-stream-slots: root is a list": ("pipewire-stream-slots.json", [1]),
    # read at startup by RTSPOutputManager (2e494fd13)
    "pipewire-rtsp-outputs: fields of the wrong type": ("pipewire-rtsp-outputs.json", {
        "enabled": "yes", "port": L, "requireGroupSource": O, "latencyMs": S}),
    # read at startup by VideoOutputManager, which needs PipeWireVideoSinkName
    # set to read it at all (2e494fd13)
    "pipewire-video-consumers: fields of the wrong type": ("pipewire-video-consumers.json", [
        {"type": "overlay", "id": "1", "pipeWireNodeName": "x"}, {"type": "rtsp", "width": L}, 5]),
}


def poke(fppd, name):
    """Run the code that reads `name` if startup doesn't."""
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
    if name.startswith("pipewire-rtsp-") and not fppd.built_with("rtsp-server"):
        # it would pass without reading the file at all
        pytest.skip("fppd was built without gst-rtsp-server: nothing reads " + name)
    fppd.write(f"config/{name}", content)
    if "stream-slots" in name:
        # the saved slot volume is read once a stream is playing
        request.getfixturevalue("audio")
    elif name.startswith("pipewire-"):
        fppd.settings(MediaBackend="pipewire")
    if "video-consumers" in name:
        fppd.settings(PipeWireVideoSinkName="fpp_video_bus")
    fppd.start()
    poke(fppd, name)
    time.sleep(0.5)
    fppd.get("/fppd/status", timeout=10)


GOOD_SUB = {"Name": "Good Sub", "parent": "M", "type": "ranges", "subBuffer": "", "ranges": ["1-3"]}


@pytest.mark.parametrize("files", [
    {"xlights-submodels.json": {"submodels": ["x", 5, {"Name": L}, None, GOOD_SUB]}},
    {"xlights-submodels.json": {"submodels": [GOOD_SUB]},
     "xlights-modelgroups.json": {"modelgroups": [5, {"Name": O}, "y"]}},
], ids=["bad submodels", "bad model groups"])
def test_submodel_index_skips_bad_entries(fppd, files):
    """The xLights submodel and model-group index is read on first use, and
    an entry it can't read is skipped: the good submodels around it are
    still listed.

    Regression: 919374a85. An entry that wasn't an object, or a Name that
    wasn't a string, threw -- answered as an empty 500, after the index had
    been marked loaded, so no submodel was listed again until fppd
    restarted.
    """
    for name, content in files.items():
        fppd.write(f"config/{name}", content)
    fppd.start()
    for _ in range(2):  # the first request loads the index; the second must too
        names = fppd.get("/models?submodels=true&simple=true", timeout=10)
        assert "Good Sub" in names, f"submodel list: {names}"


def test_plugin_command_descriptions_with_bad_entries(fppd):
    """A plugin's commands/descriptions.json is read as fppd starts. An
    entry with no name or script, or with ones that aren't strings, is
    skipped with a warning; the plugin's good command is still registered
    and fppd starts.

    Regression: 919374a85. Such an entry threw Json::LogicError at
    startup, so one plugin's typo stopped fppd starting at all.
    """
    import os
    cmds = os.path.join(fppd.media, "plugins", "fpp-test-plugin", "commands")
    os.makedirs(cmds)
    script = os.path.join(cmds, "good.sh")
    with open(script, "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(script, 0o755)
    fppd.write("plugins/fpp-test-plugin/commands/descriptions.json", [
        "x", 5, None, {"name": L, "script": "good.sh"}, {"name": "No Script"},
        {"name": "Bad Script", "script": O}, {"script": "good.sh"},
        {"name": "Test Plugin Good", "script": "good.sh", "args": []}])
    fppd.start()
    names = [c.get("name") for c in fppd.get("/commands", timeout=10)]
    assert "Test Plugin Good" in names, "the plugin's good command was not registered"
    assert "No Script" not in names and "Bad Script" not in names, names


def test_cape_sensor_sources_with_bad_entries(fppd):
    """The cape's sensor sources (tmp/cape-sensors.json, written from the
    cape's EEPROM config at boot) are read as fppd starts. A source with a
    value of the wrong JSON type is skipped, as a bad sensor already is.

    Regression: 919374a85. Such a source threw Json::LogicError at
    startup, and with the file rewritten from the cape on every boot, fppd
    never started.
    """
    fppd.write("tmp/cape-sensors.json", {
        "sensorSources": [5, "x", {"type": L}, {"type": "ads7828", "id": "a", "i2cBus": "x"},
                          {"type": "ads7828", "id": "b", "i2cBus": 1, "i2cAddress": "zz"},
                          {"type": "iio", "id": "c", "devId": O},
                          {"type": "mux", "id": "d", "source": L, "channels": S},
                          {"type": "multi", "id": "e", "sources": [5]}],
        "sensors": []})
    fppd.start()
    fppd.get("/fppd/status", timeout=10)
