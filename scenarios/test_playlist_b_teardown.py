"""Tearing playlists down while they run: a command entry that starts a
playlist (its own, or another from inside a stack of inserted ones), the
switch to an inserted playlist, and an edit that empties a section of a
playlist that is playing.

Entries append digits to a trace (see test_playlist_entries.py).
"""

import os
import time

import pytest

import shims
from test_command_presets import variable
from test_playlist_commands import start, status_name, wait_idle, wait_trace
from test_playlist_entries import http_server, pause, playlist, status, step, trace
from test_playlist_presets import preset
from test_playlist_reload import edit


def command(name, *args, **extra):
    e = {"type": "command", "enabled": 1, "playOnce": 0, "command": name,
         "args": [str(a) for a in args]}
    e.update(extra)
    return e


def bare(name, main, lead_out=()):
    """A playlist with no lead-in, so its trace isn't reset."""
    return {"name": name, "repeat": 0, "loopCount": 0, "leadIn": [],
            "mainPlaylist": list(main), "leadOut": list(lead_out)}


def number(fppd, var):
    v = variable(fppd, var)
    return int(float(v)) if v not in (None, "") else 0


def mark(port, name):
    """A URL entry that GETs /m/<name> from the test's server: these two
    tests are checked against trees from before fppd had user variables,
    which the trace needs."""
    return {"type": "url", "enabled": 1, "playOnce": 0, "method": "GET",
            "url": f"http://127.0.0.1:{port}/m/{name}", "data": ""}


def marks(got):
    return [p[len("/m/"):] for _, p, _ in got if p.startswith("/m/")]


def test_a_command_entry_that_starts_its_own_playlist(fppd):
    """A playlist whose last entry is Start Playlist of itself starts over
    each time it gets there, and fppd survives it.

    Regression: d55c54d4a. Starting the playlist reloaded it from inside
    the command entry's own StartPlaying(), which deleted every entry --
    the running one included -- while its method was still on the stack: a
    use-after-free each time round.
    """
    with http_server({}) as (port, got):
        fppd.write("playlists/P.json", bare("P", [
            mark(port, "run"), pause(1), command("Start Playlist", "P", "false", "false")]))
        fppd.start()
        start(fppd, "P")
        fppd.wait_for(lambda: marks(got).count("run") >= 4, timeout=20, interval=0.2,
                      what="the playlist to start itself over three times")
        assert status_name(fppd) == "playing"
        assert status(fppd).get("current_playlist", {}).get("playlist") == "P"
        fppd.command("Stop Now")
        wait_idle(fppd)


def test_start_at_item_from_three_inserted_playlists_deep(fppd):
    """O inserts M, M inserts I, and I's last entry is Start Playlist At
    Item N: the stack unwinds, N plays at the top level and keeps playing,
    and none of O, M or I carries on.

    Regression: bf225abf6. The Start Playlist At Item's stop ran inline from
    the entry's own start, three levels down: it handed the player back to
    a parent and condemned the level that then loaded N, which the next
    tick deleted. N blipped and vanished while an outer playlist resumed --
    or fppd crashed in Load() on the condemned playlist.
    """
    with http_server({}) as (port, got):
        fppd.write("playlists/O.json", bare("O", [
            mark(port, 1), command("Insert Playlist After Current", "M", "-1", "-1", "false"),
            pause(30), mark(port, 2)]))
        fppd.write("playlists/M.json", bare("M", [
            mark(port, 3), command("Insert Playlist After Current", "I", "-1", "-1", "false"),
            pause(30), mark(port, 4)]))
        fppd.write("playlists/I.json", bare("I", [
            mark(port, 5), command("Start Playlist At Item", "N", "2", "false", "false")]))
        fppd.write("playlists/N.json", bare("N", [mark(port, 7), mark(port, 8), pause(30),
                                                  mark(port, 9)]))
        fppd.start()
        start(fppd, "O")

        def current():
            s = status(fppd)
            return s.get("status_name"), s.get("current_playlist", {}).get("playlist"), \
                s.get("breadcrumbs", [])
        fppd.wait_for(lambda: current()[:2] == ("playing", "N"), timeout=10,
                      what="N to be the playlist playing")
        time.sleep(3)
        assert current() == ("playing", "N", []), current()
        seen = marks(got)
        assert {"1", "3", "5"} <= set(seen) and {"7", "8"} & set(seen), seen
        assert not {"2", "4"} & set(seen), f"an outer playlist carried on after N started: {seen}"
        fppd.command("Stop Now")
        wait_idle(fppd)


def test_an_inserted_playlist_starts_once(fppd):
    """Insert Playlist Immediate: the inserted playlist's first entry runs
    once, the rest of it plays, its PLAYLIST_STARTED preset runs once, and
    the first playlist resumes.

    Regression: 2d72fae8b. The switch to the inserted playlist started it a
    second time after it had already been started, which replayed its
    first entry: the trace went 1, 7, 7, 8.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(30), step(2)]))
    fppd.write("playlists/Q.json", bare("Q", [step(7), pause(1), step(8)]))
    fppd.write("config/commandPresets.json", {"commands": preset(
        "PLAYLIST_STARTED",
        ("Set Variable", "starts", "Expression", "", "1", "0", "100", "=starts+1", "false"))})
    fppd.start()
    start(fppd, "P")
    wait_trace(fppd, "1")
    time.sleep(0.5)
    fppd.command("Set Variable", "starts", "Value", "0", "1", "0", "100", "")
    fppd.command("Insert Playlist Immediate", "Q", "0", "0", "false")
    fppd.wait_for(lambda: (trace(fppd) or "").endswith("8"), timeout=6,
                  interval=0.05, what="the inserted playlist to play through")
    assert trace(fppd) == "178", f"trace {trace(fppd)!r}"
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "P",
                  timeout=5, what="P to resume")
    assert number(fppd, "starts") == 1, f"PLAYLIST_STARTED ran {number(fppd, 'starts')} times"
    fppd.command("Stop Now")
    wait_idle(fppd)


@pytest.mark.parametrize("emptied", ["main", "lead-out"])
def test_an_edit_that_empties_the_section_to_come(fppd, emptied):
    """A playing playlist is edited so that the section it is about to go
    to is gone: a repeating one loses its main section (the next pass), a
    one-pass one its lead-out. At the end of the pass it goes idle, and
    nothing the edit removed runs again.

    Regression: f684ec6f5. The section's size was checked before the
    reload that emptied it (or not at all, for the next pass), and its
    first entry was started anyway: through a stale pointer, the entry the
    reload had just removed and queued for deletion ran once more (here,
    step 1 again or the old lead-out's step 9) -- a use-after-free had the
    queue been drained first.
    """
    if emptied == "main":
        fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2)]))
        new = playlist("P", main=[], lead_out=[step(9)])
        repeat = True
    else:
        fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2)],
                                                lead_out=[step(9)]))
        new = playlist("P", main=[step(2), pause(2)])
        repeat = False
    fppd.start()
    start(fppd, "P", repeat=repeat)
    wait_trace(fppd, "1")
    edit(fppd, "P", new)
    wait_idle(fppd, timeout=15)
    time.sleep(1)
    assert status_name(fppd) == "idle"
    assert trace(fppd) == "1", f"trace {trace(fppd)!r}: a removed entry ran after the edit"
    # The player still plays.
    fppd.write("playlists/R.json", playlist("R", main=[step(4)]))
    start(fppd, "R")
    wait_trace(fppd, "4")
    wait_idle(fppd)


def test_an_edit_after_a_load_whose_stat_failed_is_picked_up(fppd):
    """A repeating playlist whose load read the file but then failed to
    stat() it (the file replaced in between) still picks up a later edit at
    the end of a pass.

    Regression: c897ba604. The load took the file's modified time from the
    failed stat() without checking it -- whatever the stack held. Here the
    shim makes that garbage a time far in the future, as it can be, and no
    edit was ever newer than it: the playlist played its old copy for good.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1), pause(2)]))
    arm = os.path.join(fppd.media, "tmp", "failstat.arm")
    fppd.start(preload=[shims.build("failstat_afteropen.c")],
               extra_env={"FAILSTAT_SUFFIX": "/playlists/P.json", "FAILSTAT_ARM": arm})
    open(arm, "w").close()
    start(fppd, "P", repeat=True)
    wait_trace(fppd, "1")
    os.remove(arm)
    edit(fppd, "P", playlist("P", main=[step(2), pause(2)]))
    fppd.wait_for(lambda: "2" in (trace(fppd) or ""), timeout=10, interval=0.2,
                  what="the edited main section to play")
    fppd.command("Stop Now")
    wait_idle(fppd)
