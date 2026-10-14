"""The PLAYLIST_* command presets fppd runs around playlist transitions."""

import time

from test_command_presets import variable
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import pause, playlist, step


def preset(name, *commands):
    """One preset entry per command, all under one preset name."""
    return [{"name": name, "command": c[0], "args": list(c[1:]), "presetSlot": 0}
            for c in commands]


def test_stop_now_stopped_preset_leaves_the_resumed_parent_playing(fppd):
    """A PLAYLIST_STOPPED preset that runs Stop Now does not stop the playlist
    an inserted one hands back to: the preset still runs when the inserted
    playlist ends, and the parent carries on.

    Regression for #3114 (fixed by 3080bab59): since presets were deferred to the end of a
    transition (339be2612), the inserted playlist's PLAYLIST_STOPPED ran after
    the parent had resumed, and its Stop Now stopped the parent -- a show
    went dark after every Remote Falcon request. FPP 9 ran it while the
    inserted playlist was still current, where Stop Now did nothing.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", {"name": "Q", "repeat": 0, "loopCount": 0, "leadIn": [],
                                    "mainPlaylist": [step(7)], "leadOut": []})
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STOPPED",
        ("Set Variable", "stopped", "Value", "seen", "1", "0", "100", ""),
        ("Stop Now",))})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    wait_trace(fppd, "17", timeout=5)
    fppd.wait_for(lambda: variable(fppd, "stopped") == "seen", timeout=5, interval=0.1,
                  what="the inserted playlist's PLAYLIST_STOPPED preset to run")
    time.sleep(1.5)
    assert status_name(fppd) == "playing", \
        "the PLAYLIST_STOPPED preset's Stop Now stopped the playlist the inserted one handed back to"

    # Ending the parent itself still stops: the preset is not disarmed.
    fppd.command("Set Variable", "stopped", "Value", "", "1", "0", "100", "")
    fppd.command("Next Playlist Item")
    wait_idle(fppd)
    fppd.wait_for(lambda: variable(fppd, "stopped") == "seen", timeout=5, interval=0.1,
                  what="PLAYLIST_STOPPED to run when the parent ends")
