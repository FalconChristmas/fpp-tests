"""Command presets: loading, reloading and firing them."""

import time


def set_variable(name, value):
    """A preset entry that sets a user variable, so a scenario can see that
    the preset ran and which version of it ran."""
    return {
        "name": "P",
        "command": "Set Variable",
        "args": [name, "Value", str(value), "1", "0", "100", ""],
        "presetSlot": 0,
    }


def variable(fppd, name):
    return fppd.get("/variables", timeout=5).get(name, {}).get("value")


def test_edit_reloads_without_wedging(fppd):
    """Saving commandPresets.json while fppd runs reloads it in place.

    Regression: 7e171ae48. The file-monitor callback held presetsMutex around
    the reload, which took it again; the first edit after startup deadlocked
    the main loop, and every later preset trigger hung.
    """
    fppd.write("config/commandPresets.json", {"commands": [set_variable("X", 1)]})
    fppd.start()

    fppd.command("Trigger Command Preset", "P", timeout=5)
    assert variable(fppd, "X") == "1"

    # The reload compares whole-second mtimes, so an edit in the same second
    # as the load is not seen (a separate, smaller bug). Save in a later
    # second, as a person editing the file would.
    time.sleep(1.1)
    fppd.write("config/commandPresets.json", {"commands": [set_variable("X", 2)]})

    def reloaded():
        fppd.command("Trigger Command Preset", "P", timeout=5)
        return variable(fppd, "X") == "2"

    fppd.wait_for(reloaded, timeout=15, interval=0.5, what="the edited preset to take effect")


def test_keyword_whose_value_contains_itself(fppd):
    """A preset keyword whose value contains the keyword, here a playlist
    named "%PLAYLIST_NAME%", is substituted once.

    Regression: 63c620bd4. ReplaceString() restarted its search from the
    start after each replacement, found the keyword again inside the text it
    had just inserted, and looped forever on whichever thread fired the
    preset -- the main loop, for playlist events.
    """
    name = "%PLAYLIST_NAME%"
    fppd.write(f"playlists/{name}.json", {
        "name": name, "repeat": 0, "loopCount": 0, "leadIn": [], "leadOut": [],
        "mainPlaylist": [{"type": "command", "enabled": 1, "playOnce": 0,
                          "command": "Set Variable",
                          "args": ["Ran", "Value", "yes", "1", "0", "100", ""]}],
    })
    fppd.write("config/commandPresets.json", {"commands": [{
        "name": "PLAYLIST_STOPPED", "command": "Set Variable",
        "args": ["Stopped", "Value", "%PLAYLIST_NAME%", "1", "0", "100", ""],
        "presetSlot": 0,
    }]})
    fppd.start()

    fppd.command("Start Playlist", name, "false", "false")
    fppd.wait_for(lambda: variable(fppd, "Stopped"), timeout=10,
                  what="the PLAYLIST_STOPPED preset to run")
    assert variable(fppd, "Ran") == "yes"
    assert variable(fppd, "Stopped") == name
