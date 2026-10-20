"""Logging fixes from 10.1 and 10.2: the log level set through the API, its
Debug/Excessive warning banner, and config files whose absence is normal
not being logged as errors."""

import re

import pytest

from show import status


def warnings(fppd):
    return status(fppd).get("warnings", [])


def banner(fppd):
    """Which log level warnings are up: a subset of {"debug", "excessive"}."""
    w = warnings(fppd)
    return ({"debug"} if any("A Log Level is set to Debug" in x for x in w) else set()) | \
        ({"excessive"} if any("A Log Level is set to Excessive" in x for x in w) else set())


def levels(fppd):
    """Every logger's level, from GET /fppd/log."""
    return fppd.get("/fppd/log").get("log", {})


def test_api_log_level_raises_and_lowers_the_banner(fppd):
    """Setting the log level through the API (the Logging settings page)
    raises the "A Log Level is set to Debug" or "...Excessive" warning, and
    setting it back to info takes it down.

    Regression: 21c0bfefc. Only the command socket's LogLevel and startup
    recomputed the banner, so a level set through the REST API left it
    showing the old level (or none) until fppd restarted."""
    fppd.start()
    assert banner(fppd) == set(), warnings(fppd)
    fppd.post("/fppd/log/level/debug")
    fppd.wait_for(lambda: banner(fppd) == {"debug"}, timeout=5, what="the Debug log warning")
    fppd.post("/fppd/log/level/excess")
    fppd.wait_for(lambda: banner(fppd) == {"excessive"}, timeout=5,
                  what="the Excessive log warning in place of the Debug one")
    fppd.post("/fppd/log/level/info")
    fppd.wait_for(lambda: banner(fppd) == set(), timeout=5, what="the log level warnings to go")


def test_global_excess_sets_every_logger_to_excessive(fppd):
    """The global log level "excess" (no channel named) sets every logger
    to excessive, as the per-channel form does.

    Regression: 9bacecc3b. The global form mapped "excess" to info, so
    asking for the most detail lowered every logger to info instead."""
    fppd.start()
    fppd.post("/fppd/log/level/excess")
    got = levels(fppd)
    assert got, fppd.get("/fppd/log")
    assert set(got.values()) == {"excess"}, got
    with open(f"{fppd.media}/settings") as f:
        saved = dict(re.findall(r'^(LogLevel_\w+) = "(.*)"$', f.read(), re.M))
    assert saved and set(saved.values()) == {"excess"}, saved


@pytest.mark.parametrize("name", ["schedule.json", "fan_probe.json", "ci-universes.json"])
def test_normal_missing_config_is_not_an_error(fppd, name):
    """A player with no schedule, no fan probe result and no bridge input
    configured -- most of them -- logs nothing about those files at its
    default log level.

    Regression: ed478d8bc. All three were reported missing at error level
    on every start ("JSON File .../schedule.json does not exist", the same
    for tmp/fan_probe.json, and "Universe file .../ci-universes.json does
    not exist")."""
    fppd.start()
    fppd.post("/fppd/schedule", {"command": "reload"})
    status(fppd)
    lines = [line for line in fppd.log().splitlines() if name in line and "does not exist" in line]
    assert not lines, "\n".join(lines[:3])


def test_playlist_start_names_the_playlist(fppd):
    """With playlist logging at debug, starting a playlist logs its name on
    the Playlist::Start() line, the first line the crash log ring is read
    from.

    Regression: ce054a6c5. The line said only "Playlist::Start()", leaving
    the name to the per-entry lines after it."""
    fppd.write("playlists/Named.json", {"name": "Named", "repeat": 0, "loopCount": 0,
                                        "leadIn": [], "leadOut": [], "mainPlaylist": [
                                            {"type": "pause", "enabled": 1, "playOnce": 0,
                                             "duration": 1}]})
    fppd.settings(LogLevel_Playlist="debug")
    fppd.start()
    fppd.command("Start Playlist", "Named", "false", "false")
    fppd.wait_for(lambda: "Playlist::Start(Named)" in fppd.log(), timeout=10,
                  what="the Start() line naming the playlist")
