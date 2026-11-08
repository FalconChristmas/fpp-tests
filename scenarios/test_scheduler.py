"""The scheduler: windows that open and close, checked on the wire.

Times are local (the container's TZ, UTC unless set). A scenario that needs a
window around "now" skips when midnight is too close for its window to fit.
"""

import datetime
import time
import urllib.error

import pytest

from ddp import DdpReceiver
from fseq import solid_frames
from show import CHANNELS, install, playlist, sequence_entry, status

STOP_GRACEFUL, STOP_HARD, STOP_GRACEFUL_LOOP = 0, 1, 2


def schedule_entry(name, start, end, stop_type=STOP_GRACEFUL, repeat=1, day=7):
    """One entry for config/schedule.json, every day, today only."""
    today = start.strftime("%Y-%m-%d")
    return {"enabled": 1, "day": day, "playlist": name,
            "startTime": start.strftime("%H:%M:%S"), "endTime": end.strftime("%H:%M:%S"),
            "startDate": today, "endDate": today, "repeat": repeat, "stopType": stop_type}


def window(start_in, end_in):
    """(start, end) datetimes relative to now; skip if they'd cross midnight."""
    now = datetime.datetime.now().replace(microsecond=0)
    start, end = now + datetime.timedelta(seconds=start_in), now + datetime.timedelta(seconds=end_in)
    if start.date() != now.date() or end.date() != now.date():
        pytest.skip("too close to midnight for a same-day window")
    return start, end


def reload_schedule(fppd):
    fppd.post("/fppd/schedule", {"command": "reload"})


def wall_of(dt):
    """monotonic() time of a local datetime."""
    return time.monotonic() + (dt.timestamp() - time.time())


def test_booting_inside_a_window_starts_its_playlist(fppd):
    """fppd started in the middle of a schedule window plays that window's
    playlist without being asked."""
    frames = solid_frames(100, CHANNELS, 91)
    start, end = window(-60, 600)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                      interval=0.5, what="the scheduled playlist to start")
        s = status(fppd)
        assert s["current_playlist"]["playlist"] == "Show", s
        assert rx.wait_frames(10), "scheduled playback sent nothing"
        assert rx.last()[:CHANNELS] == frames[0], "the wire is not showing the scheduled sequence"


def test_window_opening_starts_on_time(fppd):
    """A window that opens while fppd is idle starts its playlist at the
    window's start second: the first frame is on the wire within a second
    or two of it, and not before."""
    frames = solid_frames(100, CHANNELS, 77)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.start()
        start, end = window(8, 600)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end)])
        reload_schedule(fppd)
        due = wall_of(start)
        assert rx.wait_frames(5, timeout=30), "the window opened but nothing played"
        first = next(t for t, d in rx.snapshot() if d[:CHANNELS] == frames[0])
        assert -0.2 <= first - due <= 2.0, \
            f"first frame {first - due:+.2f} s from the window's start"


@pytest.mark.parametrize("stop_type", [STOP_HARD, STOP_GRACEFUL])
def test_window_end_stops_a_looping_playlist(fppd, stop_type):
    """A looping playlist stops when its window closes: at once for a hard
    stop, at the end of the sequence playing then for a graceful one."""
    seq_seconds = 4
    frames = solid_frames(seq_seconds * 20, CHANNELS, 55)
    with DdpReceiver(CHANNELS) as rx:
        install(fppd, frames)
        fppd.write("playlists/Show.json", playlist("Show", [sequence_entry("Show.fseq")], repeat=1))
        start, end = window(-60, 9)
        fppd.write("config/schedule.json", [schedule_entry("Show", start, end, stop_type=stop_type)])
        fppd.start()
        fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=30,
                      interval=0.5, what="the scheduled playlist to start")
        due = wall_of(end)
        fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30,
                      interval=0.2, what="the window's end to stop the playlist")
        stopped = time.monotonic() - due
        if stop_type == STOP_HARD:
            assert -0.5 <= stopped <= 2.0, f"hard stop {stopped:+.2f} s from the window's end"
        else:
            assert -0.5 <= stopped <= seq_seconds + 2.0, \
                f"graceful stop {stopped:+.2f} s from the window's end (sequence is {seq_seconds} s)"
        time.sleep(0.5)
        assert not any(rx.last()), "the output was left lit after the window closed"


def playing(fppd):
    return status(fppd).get("status_name") == "playing"


def scheduled_show(fppd, start_in, end_in, stop_type=STOP_HARD):
    install(fppd, solid_frames(40, CHANNELS, 55))
    start, end = window(start_in, end_in)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end, stop_type=stop_type)])
    return start, end


def test_extend_schedule_moves_the_stop(fppd):
    """Extend Schedule pushes the running scheduled playlist's end out by
    that many seconds: it plays past the window's end and stops at the new
    one."""
    start, end = scheduled_show(fppd, -60, 8)
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    assert fppd.command("Extend Schedule", "10", "0") == "Schedule Updated"
    time.sleep(max(0, wall_of(end) - time.monotonic()) + 3)
    assert playing(fppd), "stopped at the window's end, not the extended one"
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=15, interval=0.5,
                  what="the playlist to stop at the extended end")
    assert time.monotonic() >= wall_of(end) + 8, "stopped too early"


def test_extend_schedule_by_a_negative_amount_ends_it_early(fppd):
    start, end = scheduled_show(fppd, -60, 300)
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    fppd.command("Extend Schedule", "-290", "0")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=20, interval=0.5,
                  what="the playlist to stop at the earlier end")


@pytest.mark.parametrize("arg", ["", "abc", "10x", "  "])
def test_extend_schedule_refuses_an_argument_that_isnt_a_number(fppd, arg):
    """Extend Schedule with a Seconds that isn't a number (an unset %VAR%,
    a typo, only spaces) is refused, and the playlist plays on. (Only spaces
    used to parse as a successful 0.)

    Regression (the "  " case): 6f26fbe55. ParseIntArg() skipped the
    trailing whitespace before asking whether strtol() had consumed
    anything, so an argument of only spaces passed as 0."""
    scheduled_show(fppd, -60, 300)
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    with pytest.raises(urllib.error.HTTPError):
        fppd.command("Extend Schedule", arg, "0")
    time.sleep(1)
    assert playing(fppd)


def test_start_next_scheduled_item_starts_it_now(fppd):
    """Start Next Scheduled Item starts the next window's playlist straight
    away, while idle, rather than at its start time.

    Feature: efa4e3bd8 (the command behind the Start Next button)."""
    scheduled_show(fppd, 300, 600)
    fppd.start()
    time.sleep(2)
    assert status(fppd).get("status_name") == "idle"
    assert fppd.command("Start Next Scheduled Item") == "Next scheduled item started"
    fppd.wait_for(lambda: playing(fppd), timeout=10, interval=0.25, what="the next item to start")
    assert status(fppd)["current_playlist"]["playlist"] == "Show"


def inserted_stack(fppd, schedule):
    """Outer scheduled (and whatever else `schedule` lists), Inner inserted
    into it with Insert Playlist Immediate, a plugin listening to both.
    Returns the plugin's directory."""
    from test_playlist_entries import pause
    from test_plugin_scripts import plugin
    d = plugin(fppd)
    for name in ("Inner", "Outer", "High"):
        fppd.write(f"playlists/{name}.json", {"name": name, "repeat": 0, "loopCount": 0, "leadIn": [],
                                               "mainPlaylist": [pause(120)], "leadOut": []})
    fppd.write("config/schedule.json", schedule)
    fppd.start()
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "Outer",
                  timeout=30, interval=0.5, what="the scheduled playlist")
    fppd.command("Insert Playlist Immediate", "Inner", "0", "0", "false")
    fppd.wait_for(lambda: status(fppd).get("breadcrumbs") == ["Outer"], timeout=10,
                  interval=0.2, what="Inner to play inside Outer")
    # The main loop starts Inner and then runs its "start" and "playing"
    # callbacks, a fork each; the breadcrumbs show before they have run.  A
    # stop sent now runs its own callbacks on another thread, and Inner's
    # late "playing" lands after its "stop", where it reads as Outer resuming
    # (seen under ASan).
    from test_plugin_scripts import playlist_actions

    def inner_announced():
        acts = playlist_actions(d)
        starts = [i for i, a in enumerate(acts) if a == "start"]
        return len(starts) >= 2 and "playing" in acts[starts[1]:]
    fppd.wait_for(inner_announced, timeout=10, interval=0.1, what="Inner's start and playing callbacks")
    return d


def resumed_after_stop(actions):
    """The plugin events between the first "stop" and the next "start": a
    stop of every level is only "stop"s, never a "playing" for the playlist
    the inserted one returned to."""
    from itertools import takewhile
    if "stop" not in actions:
        return None
    after = actions[actions.index("stop"):]
    return [a for a in takewhile(lambda a: a != "start", after) if a != "stop"]


def test_window_end_hard_stops_a_playlist_inside_an_inserted_one(fppd):
    """A hard stop at the end of a window stops the scheduled playlist
    while a playlist inserted into it (Insert Playlist Immediate) is
    playing: every level stops, and fppd goes idle, without the scheduled
    playlist resuming on the way.

    Regression: b916aa139. The stop ended only the inserted playlist, and
    the scheduled one it returned to played on after its window had
    closed. (On master the window's end is checked every second, so such a
    playlist would be stopped again a second later; the test watches for
    the outer playlist playing on its own in between.)

    Regression: 2ad364a24. The levels were stopped one StopNow() at a time,
    and each hand-back resumed the parent before the next stopped it:
    plugins heard "playing" for Outer after Inner's "stop", and a status
    read could land in between (seen under TSan)."""
    from test_plugin_scripts import playlist_actions
    start, end = window(-60, 12)
    d = inserted_stack(fppd, [schedule_entry("Outer", start, end, stop_type=STOP_HARD)])
    due = wall_of(end)
    resumed = []
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        s = status(fppd)
        if s.get("status_name") == "idle":
            break
        if s.get("status_name") == "playing" and not s.get("breadcrumbs"):
            resumed.append(round(time.monotonic() - due, 2))
        time.sleep(0.05)
    stopped = time.monotonic() - due
    assert not resumed, f"Outer played on by itself after the window's end, at {resumed[:5]} s"
    assert -0.5 <= stopped <= 2.0, f"hard stop {stopped:+.2f} s from the window's end"
    time.sleep(2)
    assert status(fppd).get("status_name") == "idle", status(fppd)
    assert resumed_after_stop(playlist_actions(d)) == [], playlist_actions(d)


def test_a_higher_priority_window_hard_stops_every_level(fppd):
    """A higher-priority window opening over a lower-priority playlist that
    ends with a hard stop stops it, and the playlist inserted into it, at
    once, and starts its own playlist.

    Regression: 2ad364a24. The pre-emption stopped one level: Inner ended,
    Outer resumed, and played until a later pass stopped it again."""
    from test_plugin_scripts import playlist_actions
    s1, e1 = window(-60, 600)
    s0, e0 = window(10, 600)
    d = inserted_stack(fppd, [schedule_entry("High", s0, e0),
                              schedule_entry("Outer", s1, e1, stop_type=STOP_HARD)])
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "High",
                  timeout=30, interval=0.25, what="the higher-priority playlist")
    assert status(fppd).get("breadcrumbs") in (None, []), status(fppd)
    acts = playlist_actions(d)
    assert resumed_after_stop(acts) == [], acts


@pytest.mark.parametrize("how", ["Start Playlist", "Start Next Scheduled Item"])
def test_starting_another_playlist_stops_an_inserted_one_without_resuming(fppd, how):
    """Starting another playlist (by hand, or Start Next Scheduled Item)
    while one is inserted into a running playlist stops both and plays the
    new one, without the outer playlist resuming in between.

    Regression: 2ad364a24. The stop before the load ended one level at a
    time, 100 ms apart, and each parent resumed (plugins heard "playing")
    before the next pass stopped it; the Start Playlist command's and Start
    Next Scheduled Item's own stops ended only the inserted playlist."""
    from test_plugin_scripts import playlist_actions
    s1, e1 = window(-60, 600)
    s2, e2 = window(300, 600)
    d = inserted_stack(fppd, [schedule_entry("Outer", s1, e1, stop_type=STOP_HARD),
                              schedule_entry("High", s2, e2)])
    if how == "Start Playlist":
        fppd.command("Start Playlist", "High", "false", "false")
    else:
        assert fppd.command("Start Next Scheduled Item") == "Next scheduled item started"
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "High",
                  timeout=15, interval=0.25, what="the new playlist")
    assert status(fppd).get("breadcrumbs") in (None, []), status(fppd)
    acts = playlist_actions(d)
    assert resumed_after_stop(acts) == [], acts


def test_a_disabled_entry_is_not_scheduled(fppd):
    """A disabled entry whose window is open plays nothing and isn't in the
    plan, though it stays in the list of entries."""
    start, end = scheduled_show(fppd, -60, 600)
    fppd.write("config/schedule.json", [dict(schedule_entry("Show", start, end), enabled=0)])
    fppd.start()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        assert status(fppd).get("status_name") == "idle", "the disabled entry's playlist started"
        time.sleep(0.25)
    schedule = fppd.get("/fppd/schedule")["schedule"]
    assert len(schedule["entries"]) == 1 and schedule["items"] == [], schedule["items"]
    assert status(fppd)["scheduler"]["nextPlaylist"]["playlistName"] == "No playlist scheduled."


def test_a_reload_does_not_replay_a_finished_occurrence(fppd):
    """A non-repeating entry whose playlist has finished stays finished when
    the schedule is reloaded while its window is still open."""
    install(fppd, solid_frames(40, CHANNELS, 55))
    start, end = window(-60, 600)
    fppd.write("config/schedule.json", [schedule_entry("Show", start, end, repeat=0)])
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.25, what="the scheduled playlist to start")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=30, interval=0.25,
                  what="the playlist to finish")
    reload_schedule(fppd)
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        assert status(fppd).get("status_name") == "idle", "the reload played the finished occurrence again"
        time.sleep(0.25)
