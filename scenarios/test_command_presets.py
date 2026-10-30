"""Command presets: loading, reloading and firing them."""

import os
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
    the main loop, and every later preset trigger hung. And fdf29237e, which
    made fppd reload the presets when the file changes at all (they were
    read only at startup; the reload is now a FileMonitor callback).
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


def replace_presets(fppd, commands, mtime_ns):
    """Replace commandPresets.json the way FPP's own writers do (temp file,
    then rename), arriving with the given modification time already set."""
    path = os.path.join(fppd.media, "config", "commandPresets.json")
    tmp = fppd.write("config/.commandPresets.json.tmp", {"commands": commands})
    os.utime(tmp, ns=(mtime_ns, mtime_ns))
    os.rename(tmp, path)


def test_two_saves_in_one_second_both_load(fppd):
    """A save in the same second as the previous one is still picked up.

    Regression: ad22d9f73. The reload compared whole-second modification times and
    skipped a file whose second matched the last load, so the second of two
    quick saves was lost until the file was saved again.
    """
    fppd.write("config/commandPresets.json", {"commands": [set_variable("X", 1)]})
    fppd.start()

    def becomes(value):
        def check():
            fppd.command("Trigger Command Preset", "P", timeout=5)
            return variable(fppd, "X") == str(value)
        return check

    # Both saves are stamped inside one whole second, later than the load.
    second = (int(time.time()) + 5) * 1_000_000_000
    replace_presets(fppd, [set_variable("X", 2)], second + 200_000_000)
    fppd.wait_for(becomes(2), timeout=15, interval=0.25, what="the first save to load")
    replace_presets(fppd, [set_variable("X", 3)], second + 700_000_000)
    fppd.wait_for(becomes(3), timeout=15, interval=0.25, what="the second save to load")


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


def rss_mb(pid):
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0


def test_fired_preset_timers_leave_nothing_behind(fppd):
    """Each "Trigger Command Preset In Future" with a new identifier is a
    new named timer; once it has fired, fppd keeps nothing of it.

    Regression: 0dc15ea9c. bb1e3e3b6 kept an epoch per timer name in a map
    that every fired timer added to and nothing removed from, so timers
    that take a fresh name each time (this command's identifiers, a
    per-play media stop, each pass of looping media) grew fppd for as long
    as it ran. 1 MB identifiers make that measurable: 50 of them kept
    51 MB, against under 3 MB with the fix. Repeating one identifier first
    warms the same paths without growing the map, and ASan's quarantine is
    off so freed memory leaves the RSS as it would in a normal build."""
    fppd.start(extra_env={"ASAN_OPTIONS": (
        "halt_on_error=1:detect_leaks=0:abort_on_error=0:quarantine_size_mb=0:"
        f"log_path={fppd.media}/logs/asan")})
    pad = "x" * (1024 * 1024)

    def trigger(ident):
        fppd.post("/command", {"command": "Trigger Command Preset In Future",
                               "args": [ident + pad, "0", "no such preset"]}, timeout=30)

    for _ in range(60):
        trigger("same")
    time.sleep(1.5)
    before = rss_mb(fppd.proc.pid)
    for i in range(50):
        trigger(f"{i:04d}")
    time.sleep(1.5)  # every timer has fired
    grew = rss_mb(fppd.proc.pid) - before
    assert grew < 20, f"fppd grew {grew:.1f} MB over 50 fired preset timers"
