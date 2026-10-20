"""Playlist fixes from 10.1 and 10.2: a repeating sequence+media playlist's
second pass, Time branch windows that cross midnight or the hour, playlist
commands given no playlist name, Set Playlist Repeat on an idle player and
the plugin playlist callbacks.

The branch and command scenarios use test_playlist_entries' trace: each step
appends a digit to the user variable "trace", so the order fppd ran them in
is read back from /variables.
"""

import time
import urllib.error

import pytest

from ddp import DdpReceiver
from show import CHANNELS, playlist as show_playlist
from test_playlist_entries import branch, playlist, run, status, step, trace
from test_playlist_media import both, song
from test_plugin_scripts import playlist_actions, plugin


def test_repeating_song_plays_every_pass(fppd, audio):
    """A repeating playlist of one 2 s sequence+media entry plays its lights
    on every pass, not just the first.

    Regression: 2f31d5619. Since the sequence of a song entry is started once
    its media is audible, a repeat reused the entry with its sequence still
    marked started and finished from the pass before: the entry ended about
    11 ms after its media started, and the playlist ran through its entries
    endlessly without playing anything again. An entry with a media offset
    (as here) never started its sequence again: IsStarted() stayed true.
    """
    index = {f: i for i, f in enumerate(song(fppd, 2))}
    # With a media offset the sequence is started from Process() once the
    # offset has passed; here the media is audible at once on every pass (the
    # output stream persists), so the hold-for-audio start never waits.
    fppd.settings(globalMediaOffset="200")
    fppd.write("playlists/Song.json", show_playlist("Song", [both("Song.fseq", "Song.wav")],
                                                    repeat=1))
    with DdpReceiver(CHANNELS) as rx:
        fppd.start()
        began = time.monotonic()
        fppd.command("Start Playlist", "Song", "true", "false")
        time.sleep(13)
        got = [index.get(f, -1) for _, f in rx.snapshot(began)]
    fppd.command("Stop Now")
    # A pass is a run of frames up into the 30s (of 40) and back down to the
    # first few: count the falls.
    passes, high = 0, False
    for i in got:
        if i >= 30:
            high = True
        elif high and 0 <= i <= 5:
            passes += 1
            high = False
    assert passes >= 3, (f"{passes} wraps in 13 s of a repeating 2 s song; "
                         f"highest frame seen {max(got, default=None)}")


def time_branch(**window):
    """Rows: 1 step 1, 2 the branch, 3 step 9, 4 step 2, 5 Stop Now, 6 step 3
    -- the true path traces "12", the false path "13"."""
    stop = {"type": "command", "enabled": 1, "playOnce": 0, "command": "Stop Now", "args": []}
    return playlist("P", main=[
        step(1),
        branch("Time", true_type="Index", false_type="Index",
               trueNextSection="main", trueNextItem=4,
               falseNextSection="main", falseNextItem=6, **window),
        step(9), step(2), stop, step(3)])


def any_hour(start_min, end_min, end_hour=-1):
    """The deprecated compInfo form of a Time window: hour -1 is "any hour"."""
    return {"compInfo": {"startHour": -1, "startMinute": start_min, "startSecond": 0,
                         "endHour": end_hour, "endMinute": end_min, "endSecond": 0}}


@pytest.mark.parametrize("window, now, expect", [
    # 22:00-02:00 runs past midnight (d8ffe6706)
    ({"startTime": "22:00:00", "endTime": "02:00:00"}, "23:30:00", "12"),
    ({"startTime": "22:00:00", "endTime": "02:00:00"}, "01:00:00", "12"),
    ({"startTime": "22:00:00", "endTime": "02:00:00"}, "03:00:00", "13"),
    # :50 to :10 of any hour runs past the top of the hour (611f81cd5)
    (any_hour(50, 10), "14:05:00", "12"),
    (any_hour(50, 10), "14:30:00", "13"),
    # any-hour start, fixed 02:00 end: true until 02:00 (611f81cd5)
    (any_hour(0, 0, end_hour=2), "01:30:00", "12"),
    (any_hour(0, 0, end_hour=2), "02:30:00", "13"),
], ids=["past-midnight-late", "past-midnight-early", "past-midnight-outside",
        "past-the-hour-inside", "past-the-hour-outside", "end-only-inside", "end-only-outside"])
def test_time_branch_window(fppd, window, now, expect):
    """A Time branch whose window wraps -- past midnight, or past the top of
    the hour for an any-hour window -- is true inside it, and a window with
    only an end time is true before that end.

    Regression: d8ffe6706 (past midnight) and 611f81cd5 (past the hour, end
    only). No time is both at or after 22:00 and before 02:00, so such a
    branch always took the false path; the any-hour :50-:10 window had the
    same problem, and an end-only window's test repeated the start-time
    check and fell through to the minutes-only comparison.
    """
    fppd.write("playlists/P.json", time_branch(**window))
    fppd.start(fake_time=f"2027-03-10 {now}")
    assert run(fppd, "P") == expect


def test_branch_warning_expires(fppd):
    """A branch with an unreadable start time raises a warning that goes
    away by itself about a minute later.

    Regression: d8ffe6706. The branch warnings were raised with no timeout,
    so the banner stayed until fppd restarted, even after the playlist was
    fixed and saved.
    """
    fppd.write("playlists/P.json", time_branch(startTime="bogus", endTime="02:00:00"))
    fppd.start()
    run(fppd, "P")

    def flagged():
        return any("invalid start time" in w for w in status(fppd).get("warnings", []))
    fppd.wait_for(flagged, timeout=10, what="the invalid start time warning")
    fppd.wait_for(lambda: not flagged(), timeout=90, interval=1,
                  what="the branch warning to expire")


@pytest.mark.parametrize("command, args", [
    ("Start Playlist At Item", ["", "1", "false", "false", "false"]),
    ("Start Playlist", ["", "false", "false"]),
    ("Toggle Playlist", ["", "false"]),
    ("Start Playlist At Random Item", ["", "false", "false"]),
    ("Insert Playlist After Current", ["", "-1", "-1", "false"]),
    ("Insert Playlist Immediate", ["", "0", "0", "false"]),
    ("Insert Random Item From Playlist", ["", "false"]),
])
def test_playlist_command_without_a_name_is_an_error(fppd, command, args):
    """A playlist command whose playlist name is empty (the UI posting with
    nothing selected, a variable that resolved to nothing) is refused with
    an error, and the player stays idle.

    Regression: ce6ed3107 (#2944). Only a missing argument was refused; an
    explicit "" reached the command, and "Start Playlist At Item" matched it
    to the equally empty name of the playlist the scheduler wanted, deferred
    to the scheduler, started nothing and answered success -- so the UI said
    "Playlist Started" with the player sitting idle.
    """
    fppd.write("playlists/P.json", playlist("P", main=[step(1)]))
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.command(command, *args)
    assert e.value.code >= 400, e.value.code
    assert "playlist name" in e.value.body, e.value.body
    time.sleep(1)
    assert status(fppd).get("status_name") == "idle", status(fppd)
    assert "no playlist name was given" in fppd.log()


def test_set_playlist_repeat_while_idle_is_refused(fppd):
    """Set Playlist Repeat with no playlist running is an error and changes
    nothing: the next Start Playlist still uses its own repeat flag. While a
    playlist runs it changes the status's repeat_mode at once.

    Feature: 483874dd5 (the command; test_playlist_commands drives it on a
    running playlist)."""
    fppd.write("playlists/P.json", playlist("P", main=[step(1), {
        "type": "pause", "enabled": 1, "playOnce": 0, "duration": 2}]))
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.command("Set Playlist Repeat", "true")
    assert "No playlist is running" in e.value.body, e.value.body
    assert run(fppd, "P", timeout=15) == "1", "a refused repeat carried into the next start"
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", what="the playlist")
    assert int(status(fppd).get("repeat_mode", -1)) == 0
    fppd.command("Set Playlist Repeat", "true")
    assert int(status(fppd).get("repeat_mode", -1)) == 1, status(fppd)
    fppd.command("Stop Now")


def test_playlist_callbacks_start_playing_and_stop(fppd):
    """A one-entry playlist tells plugins "start" and then "playing" for its
    entry, and after "stop" nothing more.

    Regression: 00b23cca5. "playing" was sent as each later item began, never
    for the first, so a plugin waiting for it never heard it on a one-entry
    playlist; and every playlist ended with "stop" followed at once by a
    "playing" for the reset section, so a plugin powering hardware up on
    "playing" turned it back on when the show ended. (The "start" half --
    the callback said "playing" for a fresh start -- is pinned by
    test_plugin_scripts' lifecycle test.)
    """
    d = plugin(fppd)
    fppd.write("playlists/P.json", show_playlist("P", [{
        "type": "pause", "enabled": 1, "playOnce": 0, "duration": 1}]))
    fppd.start()
    fppd.command("Start Playlist", "P", "false", "false")
    fppd.wait_for(lambda: "stop" in playlist_actions(d), timeout=20,
                  what="the playlist's stop event")
    time.sleep(2)
    acts = [a for a in playlist_actions(d) if a in ("start", "playing", "stop")]
    assert acts == ["start", "playing", "stop"], playlist_actions(d)
