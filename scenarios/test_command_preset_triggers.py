"""Firing command presets: what fppd logs for a preset that isn't there,
the presets fppd's own events fire (MEDIA_STARTED, PLAYLIST_STARTED, ...)
when none is defined, and the arguments a JSON command can carry."""

import os
import time
import urllib.error

from audio import write_tone_wav
from show import playlist, status
from test_commands import variable


def set_variable(name, value):
    return {"command": "Set Variable", "args": [name, "Value", str(value), "1", "0", "100", ""]}


def preset(name, cmd, slot=0):
    return {"name": name, "command": cmd["command"], "args": cmd["args"], "presetSlot": slot}


def missing_warnings(fppd, name):
    return fppd.log().count(f'No preset found for name "{name}"')


def trigger(fppd, name):
    try:
        return fppd.command("Trigger Command Preset", name)
    except urllib.error.HTTPError as e:
        return e.body


def test_a_missing_preset_is_warned_about_once_until_the_presets_change(fppd):
    """Triggering a preset that doesn't exist logs a warning naming it, once
    however often it is triggered; once commandPresets.json changes, the
    next trigger of a still-missing name warns again.

    Regression: 17a7dde0b, which added the warning (before it a missing
    preset was skipped without a word), and 7a5aef272, which logs it once
    per name until the presets reload (an event preset no one defined,
    fired on every media file, filled the log)."""
    fppd.write("config/commandPresets.json", {"commands": [preset("There", set_variable("X", 1))]})
    fppd.start()
    for _ in range(3):
        trigger(fppd, "Nope")
    time.sleep(0.5)
    assert missing_warnings(fppd, "Nope") == 1, \
        f"{missing_warnings(fppd, 'Nope')} warnings for three triggers of a missing preset, not 1"

    time.sleep(1.1)  # a later second than the load, as an edit would be
    fppd.write("config/commandPresets.json", {"commands": [preset("There", set_variable("X", 2))]})

    def reloaded():
        trigger(fppd, "There")
        return variable(fppd, "X") == "2"

    fppd.wait_for(reloaded, timeout=15, interval=0.5, what="the edited presets to load")
    trigger(fppd, "Nope")
    trigger(fppd, "Nope")
    time.sleep(0.5)
    assert missing_warnings(fppd, "Nope") == 2, \
        f"{missing_warnings(fppd, 'Nope')} warnings in all, not 2: none again after the reload"


def test_fppds_own_events_with_no_preset_defined_log_nothing(fppd):
    """fppd starting and a playlist starting and stopping fire the
    FPPD_STARTED, PLAYLIST_STARTED and PLAYLIST_STOPPED presets; with none
    of them defined (only an unrelated preset), nothing about a missing
    preset is logged.

    Regression: 10d3eb266 (#2514). Every event fired TriggerPreset() for its
    name whether or not a preset had it, so with 17a7dde0b's warning each
    event logged "No preset found" for a preset the user never made."""
    fppd.write("config/commandPresets.json", {"commands": [preset("Other", set_variable("X", 1))]})
    fppd.write("playlists/P.json", playlist("P", [
        {"type": "pause", "enabled": 1, "playOnce": 0, "duration": 1}]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=10,
                  what="the playlist to play")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=10,
                  what="the playlist to end")
    time.sleep(0.5)
    lines = [l for l in fppd.log().splitlines() if "No preset found" in l]
    assert not lines, "warnings for events no preset was made for:\n" + "\n".join(lines)


def test_play_media_fires_media_started_and_media_stopped(fppd, audio):
    """Play Media fires the MEDIA_STARTED preset when the file starts and
    MEDIA_STOPPED when it ends by itself, each with %MEDIA_NAME% set to the
    file's name.

    Regression: 7963f6ca1, which added both to the Play Media command (only
    a playlist's media fired them)."""
    write_tone_wav(os.path.join(fppd.media, "music", "Tone.wav"), 1)
    fppd.write("config/commandPresets.json", {"commands": [
        preset("MEDIA_STARTED", set_variable("Started", "%MEDIA_NAME%")),
        preset("MEDIA_STOPPED", set_variable("Stopped", "%MEDIA_NAME%"))]})
    fppd.start()
    fppd.command("Play Media", "Tone.wav", "1", "0", timeout=10)
    fppd.wait_for(lambda: variable(fppd, "Started") == "Tone.wav", timeout=5,
                  what="MEDIA_STARTED to set Started")
    fppd.wait_for(lambda: variable(fppd, "Stopped") == "Tone.wav", timeout=10,
                  what="MEDIA_STOPPED to set Stopped when the file ended")


def test_a_null_argument_in_a_json_command_is_an_empty_one(fppd):
    """A JSON command whose args hold null (what a page's JSON.stringify
    makes of an unset value), run directly and from a preset, runs with ""
    in its place.

    Coverage for e5068483a, which pushed "" for a null by hand: jsoncpp's
    asString() already returns "" for null, so the revert behaves the
    same here (no red)."""
    fppd.write("config/commandPresets.json", {"commands": [
        {"name": "N", "command": "Set Variable", "args": ["FromPreset", "Value", None, "1", "0", "100", None],
         "presetSlot": 0}]})
    fppd.start()
    fppd.post("/command", {"command": "Set Variable", "args": ["Direct", "Value", "x", "1", "0", "100", ""]})
    assert variable(fppd, "Direct") == "x"
    fppd.post("/command", {"command": "Set Variable", "args": ["Direct", "Value", None, "1", "0", "100", None]})
    assert variable(fppd, "Direct") in ("", "None"), variable(fppd, "Direct")
    fppd.command("Trigger Command Preset", "N")
    assert "FromPreset" in fppd.get("/variables"), fppd.get("/variables")
    assert variable(fppd, "FromPreset") in ("", "None"), variable(fppd, "FromPreset")
    fppd.check_alive()
