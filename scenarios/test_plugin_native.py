"""Compiled (C++) plugins: a plugin HTTP route that throws gets a 500, and
fppd keeps running. (What a plugin throws while loading or from
multiSyncData() is in test_native_plugins.py.)

The plugin is tools/throwplugin.cpp, built against the tree under test
(throw_plugin.py).
"""

import os
import time
import urllib.error

import pytest

import throw_plugin


def start(fppd):
    throw_plugin.install(fppd)
    fppd.start()
    fppd.wait_for(lambda: fppd.get("/throw/ok") == "ok", timeout=10, interval=0.2,
                  what="the plugin's routes to answer")


@pytest.mark.parametrize("route", ["/throw/std", "/throw/int"])
def test_a_plugin_route_that_throws_answers_500(fppd, route):
    """A plugin's HTTP handler that throws -- a std::exception or anything
    else -- gets the request a 500, and fppd carries on serving.

    Regression: d9351bd70. Plugin routes are dispatched from drogon's
    default handler, which has no try/catch around it: the exception reached
    the event loop and terminated fppd.

    Also covers 547a957ac, under TSan: drogon's quit() freed the router
    whose default handler had just served these routes while that IO thread
    had not been joined.
    """
    start(fppd)
    for _ in range(3):
        with pytest.raises(urllib.error.HTTPError) as e:
            fppd.get(route)
        assert e.value.code == 500, f"{route} answered {e.value.code}"
    assert fppd.get("/throw/ok") == "ok"



def test_a_plugin_is_told_when_a_playlist_is_inserted(fppd):
    """playlistInserted() is called with the playlist, the start and end
    positions and whether it was inserted at once, for Insert Playlist After
    Current and Insert Playlist Immediate, also when nothing is playing.

    Feature: 32244ca9a. Plugins had no way to prepare for an inserted
    playlist.
    """
    from native_plugin import install
    install(fppd, features=["NATIVE_PLAYLIST_INSERTED"])
    log = os.path.join(fppd.media, "tmp", "inserted.log")
    for name in ("Ins", "Ins2"):
        fppd.write(f"playlists/{name}.json", {"name": name, "version": 3, "repeat": 0, "loopCount": 0, "empty": False,
                                              "desc": "", "mainPlaylist": [
                                                  {"type": "pause", "enabled": 1, "playOnce": 0, "duration": 1},
                                                  {"type": "pause", "enabled": 1, "playOnce": 0, "duration": 1}],
                                              "playlistInfo": {}})
    fppd.start(extra_env={"NATIVE_PLAYLIST_LOG": log})
    fppd.command("Insert Playlist After Current", "Ins", "0", "1")
    fppd.command("Insert Playlist Immediate", "Ins2", "1", "2")

    def lines():
        try:
            with open(log) as f:
                return f.read().split("\n")[:-1]
        except FileNotFoundError:
            return []
    fppd.wait_for(lambda: len(lines()) >= 2, timeout=10, what="both insertions to be reported")
    # the command takes 1-based positions (0: none); the plugin gets them 0-based, -1 for none
    assert lines()[:2] == ["Ins -1 0 0", "Ins2 0 1 1"], lines()
