"""Scheduler fixes from the October audit: schedule.json fppd can only partly
read, holidays and sun times, repeat expansion, warnings that must come down,
command entries, and a paused scheduled playlist."""

import datetime
import time

from show import status
from test_schedule_calendar import YEAR, ZONE, entry, items
from test_scheduler import reload_schedule


def warnings(fppd):
    return fppd.get("/fppd/status").get("warnings", [])


def test_wrong_typed_schedule_entry_is_skipped(fppd):
    """fppd starts with a schedule.json holding entries it can't read (a
    field of the wrong type, an entry that isn't an object), skips them with
    a warning, and schedules the good one.

    Regression: 903dc31e6. The loader read every field with asInt() and
    friends, which throw on "day": "7"; nothing above caught it, so fppd died
    at startup, and again on every restart.
    """
    good = entry(7, "20:00:00", "21:00:00")
    schedule = [dict(entry(7, "18:00:00", "19:00:00"), day="7"), "not an entry", good]
    got = items(fppd, schedule, f"{YEAR}-06-10 12:00:00")
    from zoneinfo import ZoneInfo
    starts = {datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).strftime("%H:%M")
              for i in got}
    assert "20:00" in starts, got[:3]
    assert any("chedule" in w for w in warnings(fppd)), warnings(fppd)


def test_fixing_the_schedule_takes_its_warning_down(fppd):
    """A schedule warning (here a negative repeat interval) goes away once
    schedule.json is fixed and reloaded.

    Regression: 7e4060ed5. Schedule configuration warnings were raised with
    no timeout and most had no matching removal, so they stayed on every page
    until fppd restarted, even after the schedule was fixed.
    """
    def flagged():
        return any("negative repeat" in w for w in warnings(fppd))

    items(fppd, [entry(7, "20:00:00", "21:00:00", repeat=-100)], f"{YEAR}-06-10 12:00:00")
    fppd.wait_for(flagged, timeout=10, what="a warning about the negative repeat")
    fppd.write("config/schedule.json", [entry(7, "20:00:00", "21:00:00")])
    reload_schedule(fppd)
    fppd.wait_for(lambda: not flagged(), timeout=10,
                  what="the warning to come down after the fix")


def test_lunar_holiday_past_its_table_warns(fppd):
    """A Chinese New Year entry in a year the date table doesn't cover raises
    a warning naming the holiday and year, rather than quietly scheduling a
    made-up date.

    Regression: cb1f7e114. Past the tables (they end in 2035) the schedule
    used Feb 1 without a word. Needs cc4e94b2a too: before it fppd read the
    holiday tables only from /opt/fpp, so outside a device it had none; the
    red/green check for cb1f7e114 ran with cc4e94b2a applied to both sides.
    """
    year = 2040
    e = entry(7, "20:00:00", "21:00:00", startDate="ChineseNewYear", endDate="ChineseNewYear")
    items(fppd, [e], f"{year}-01-05 12:00:00")
    fppd.wait_for(lambda: any("Chinese" in w and str(year) in w for w in warnings(fppd)),
                  timeout=10, what=f"a warning that Chinese New Year {year} is unknown")


def easter(year):
    """Gregorian Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = (h + l - 7 * m + 114) % 31 + 1
    return datetime.date(year, month, day)


def test_easter_relative_holiday_east_of_utc(fppd):
    """Mothering Sunday (Easter - 21), scheduled east of UTC, falls on its
    Sunday.

    Regression: c8a77b40d. The offset was applied to UTC midnight and
    converted with localtime(): right west of UTC, a day late east of it, so
    Mothering Sunday came out on a Monday. Also cc4e94b2a: fppd read the
    holiday tables only from /opt/fpp, so an install elsewhere knew no
    holiday names and ran the entry across its whole date range (c8a77b40d
    was checked with cc4e94b2a applied to both sides).
    """
    from zoneinfo import ZoneInfo
    zone = "Europe/Berlin"
    want = easter(YEAR) - datetime.timedelta(days=21)
    fppd.settings(Locale="UK")
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.write("config/schedule.json", [entry(7, "10:00:00", "11:00:00",
                                              startDate="MotheringSunday",
                                              endDate="MotheringSunday")])
    start = want - datetime.timedelta(days=5)
    fppd.start(fake_time=f"{start.isoformat()} 12:00:00", tz=zone)
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    days = {datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(zone)).date() for i in got}
    assert days == {want}, f"Mothering Sunday {YEAR} is {want}; scheduled on {sorted(days)}"


def test_sun_relative_offset_runs_past_midnight(fppd):
    """SunSet plus four hours, far north in midsummer, starts after midnight
    at sunset + 4 h, not at a clamped 8 PM.

    Regression: 060dcb3ff (completing f595ad413). f595ad413 stopped clamping
    an offset that carries the time out of its day, but each day's lookup
    started from the previous day's resolved time (written back into the
    entry), so from 02:45 the sun search found the previous evening's sunset
    and every day after the first was clamped to 8 AM.
    """
    from zoneinfo import ZoneInfo
    zone = "Europe/Oslo"
    fppd.settings(Latitude="60.0", Longitude="10.75")
    e = entry(7, "SunSet", "SunSet", startTimeOffset=240, endTimeOffset=300,
              startDate=f"{YEAR}-06-20", endDate=f"{YEAR}-06-22")
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.write("config/schedule.json", [e])
    fppd.start(fake_time=f"{YEAR}-06-20 12:00:00", tz=zone)
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    assert got, "nothing scheduled"
    first = datetime.datetime.fromtimestamp(got[0]["startTime"], ZoneInfo(zone))
    # Sunset at 60N on 20 June is about 22:45 local; + 4 h is about 02:45.
    assert first.date() == datetime.date(YEAR, 6, 21) and 1 <= first.hour <= 4, \
        f"SunSet + 4 h on {YEAR}-06-20 scheduled for {first}"


def test_repeating_command_is_expanded_only_a_few_days_ahead(fppd):
    """A command repeating every 5 minutes for a whole year is expanded only
    days ahead, and the schedule status stays quick to answer.

    Regression: e16ca95a7. Repeats were expanded across the whole schedule
    distance, close to 10,000 items for a 5-minute repeat, each turned into
    JSON under the schedule lock by every schedule status request.
    """
    e = entry(7, "00:00:00", "23:59:00", playlist="", command="Volume Set", args=["50"],
              repeat=500)
    got = items(fppd, [e], f"{YEAR}-06-10 12:00:00")
    began = time.monotonic()
    fppd.get("/fppd/schedule", timeout=10)
    took = time.monotonic() - began
    assert len(got) <= 3 * 24 * 12, f"{len(got)} items for a 5-minute repeat"
    print(f"{len(got)} items, schedule status in {took * 1000:.0f} ms")


def test_scheduled_start_playlist_command_runs(fppd):
    """A command entry that runs the "Start Playlist" command starts the
    playlist at its time.

    Regression: 5915594c0. Items were told apart by their command string, and
    a playlist entry's start is stored as "Start Playlist", so this command
    entry was taken for a playlist entry with no playlist: marked ran, never
    run.
    """
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1,
                                                         "playOnce": 0, "duration": 30}]})
    start = datetime.datetime(YEAR, 6, 10, 12, 0, 10)
    e = entry(7, start.strftime("%H:%M:%S"), start.strftime("%H:%M:%S"), playlist="",
              command="Start Playlist", args=["Show", "false", "false"])
    fppd.write("config/schedule.json", [e])
    fppd.start(fake_time=f"{YEAR}-06-10 12:00:00", tz=ZONE)
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "Show",
                  timeout=30, interval=0.5, what="the scheduled Start Playlist command to run")


def test_paused_scheduled_playlist_stops_at_the_end_of_its_window(fppd):
    """A scheduled playlist paused during its window stops when the window
    ends, so the scheduler can start the next show.

    Regression: 5ce28ff2b (repaired by 41485599f; checked red at 8aff2cf96,
    the last commit before it that builds). The stop time was enforced
    only while the playlist was PLAYING: a paused one never stopped, and the
    scheduler starts nothing while the player isn't idle, so every later show
    was skipped until someone stopped it by hand.
    """
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1,
                                                         "playOnce": 0, "duration": 60}]})
    fppd.write("config/schedule.json", [entry(7, "12:00:00", "12:00:20", stopType=0)])
    fppd.start(fake_time=f"{YEAR}-06-10 12:00:02", tz=ZONE)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=15,
                  what="the scheduled playlist to start")
    fppd.command("Pause Playlist")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "paused", timeout=5,
                  what="the playlist to pause")
    fppd.wait_for(lambda: status(fppd).get("status_name") == "idle", timeout=40, interval=0.5,
                  what="the paused playlist to stop at the end of its window")


def test_a_command_entry_with_an_object_argument_runs(fppd):
    """A command entry whose args include a JSON object (an If command's
    condition, or any command given one) counts down and runs, and fppd
    survives it.

    Regression: c6a5be4ba. The scheduler logged each arg with asString(),
    which throws on an object; nothing on the main loop caught it, so fppd
    aborted during the countdown, and again after every restart until the
    entry's time had passed.
    """
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1,
                                                         "playOnce": 0, "duration": 30}]})
    start = datetime.datetime(YEAR, 6, 10, 12, 0, 10)
    e = entry(7, start.strftime("%H:%M:%S"), start.strftime("%H:%M:%S"), playlist="",
              command="Start Playlist", args=["Show", {"not": "a string"}, "false"])
    fppd.write("config/schedule.json", [e])
    fppd.start(fake_time=f"{YEAR}-06-10 12:00:00", tz=ZONE)
    fppd.wait_for(lambda: status(fppd).get("current_playlist", {}).get("playlist") == "Show",
                  timeout=30, interval=0.5, what="the scheduled command with an object arg to run")


def test_sun_relative_offset_out_of_range_is_refused(fppd):
    """A sun-relative start offset past a day (2000 minutes) is ignored with
    a warning: the entry starts at sunset like one with no offset.

    Regression: 16f0f5262. The time offsets went in unchecked: this one
    started the show at sunset plus 33 hours, without a word, and a large
    negative one put the first occurrence decades back and made every
    schedule load step forward from there for minutes.
    """
    fppd.settings(Latitude="40.7128", Longitude="-74.0060")
    got = items(fppd, [entry(7, "SunSet", "23:59:00"),
                       entry(7, "SunSet", "23:59:00", startTimeOffset=2000)],
                f"{YEAR}-06-10 12:00:00")
    first = {}
    for i in got:
        first.setdefault(i["id"], i["startTime"])
        first[i["id"]] = min(first[i["id"]], i["startTime"])
    assert 0 in first and first.get(1) == first[0], first
    assert any("startTimeOffset out of range" in w for w in warnings(fppd)), warnings(fppd)


def test_sunset_in_the_polar_night_is_in_the_evening(fppd):
    """A SunSet entry far enough north that the sun doesn't rise in
    December starts at 8 PM, the time a show without a sunset falls back
    to.

    Regression: da4fa51b0 (SP-9). With no sunset the lookup returned time
    0, which the before-the-day-starts clamp turned into 8 AM.
    """
    from zoneinfo import ZoneInfo
    zone = "Europe/Oslo"
    fppd.settings(Latitude="78.22", Longitude="15.65")
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.write("config/schedule.json", [entry(7, "SunSet", "23:00:00", startDate=f"{YEAR}-12-15",
                                              endDate=f"{YEAR}-12-20")])
    fppd.start(fake_time=f"{YEAR}-12-15 12:00:00", tz=zone)
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    assert got, "nothing scheduled"
    first = datetime.datetime.fromtimestamp(got[0]["startTime"], ZoneInfo(zone))
    assert first.hour == 20, f"SunSet in the polar night scheduled for {first}"


def test_time_format_too_long_for_the_buffer_is_left_empty(fppd):
    """A date format whose result doesn't fit the scheduler's buffer gives
    an empty time string in the schedule status, not whatever the failed
    format left in the buffer.

    Regression: e37a13abf. strftime() failed (returned 0) and left the
    buffer unterminated, and the scheduler copied it into the JSON anyway,
    reading past the end of the buffer.
    """
    fppd.settings(DateFormat="%Y-%m-%d %Y-%m-%d %Y", TimeFormat="%H:%M")
    got = items(fppd, [entry(7, "20:00:00", "21:00:00")], f"{YEAR}-06-10 12:00:00")
    assert got, "nothing scheduled"
    strs = [i["startTimeStr"] for i in got]
    assert all(s == "" for s in strs), strs[:3]


def test_extend_schedule_after_2038(fppd):
    """Extend Schedule with a limit moves an entry due within that limit
    later by the extension, also once the clock is past January 2038.

    Regression: 0b3f1a8a3. The limit was passed on as an int: past 2038
    it wrapped negative, read as already expired, and the extension was
    dropped instead of applied.
    """
    from zoneinfo import ZoneInfo
    year = 2039
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1,
                                                         "playOnce": 0, "duration": 600}]})
    show = entry(7, "12:00:00", "13:00:00", startDate=f"{year}-01-01", endDate=f"{year}-12-31")
    late = entry(7, "12:30:00", "12:45:00", startDate=f"{year}-01-01", endDate=f"{year}-12-31")
    fppd.write("config/schedule.json", [show, late])
    fppd.start(fake_time=f"{year}-06-10 12:00:05", tz=ZONE)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=15,
                  what="the scheduled playlist to start")

    def late_start():
        for i in fppd.get("/fppd/schedule")["schedule"]["items"]:
            if i["id"] == 1:
                return datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).strftime("%H:%M")
    assert late_start() == "12:30"
    fppd.command("Extend Schedule", "300", "3600")
    fppd.wait_for(lambda: late_start() == "12:35", timeout=10,
                  what="the entry due within the limit to move 5 minutes later")


def test_coordinates_of_nan_are_not_numeric(fppd):
    """Latitude and Longitude of "nan" raise the coordinates warning and
    fall back to the default location, as any other value that isn't a
    number does.

    Regression: da4fa51b0 (SP-9). The coordinates were parsed with
    std::stod, which takes "nan" and "inf": no warning, and the sun times
    came out of NaN arithmetic.
    """
    fppd.settings(Latitude="nan", Longitude="nan")
    items(fppd, [entry(7, "SunSet", "23:00:00")], f"{YEAR}-06-10 12:00:00")
    fppd.wait_for(lambda: any("Latitude/Longitude" in w for w in warnings(fppd)), timeout=10,
                  what="the coordinates warning")


def coordinates_flagged(fppd):
    return any("Latitude/Longitude" in w for w in warnings(fppd))


def test_coordinates_warning_comes_down_with_the_last_sun_entry(fppd):
    """Coordinates that don't parse ("N38.9") and a SunSet entry raise the
    coordinates warning; once schedule.json no longer has a sun-relative
    entry and is reloaded, the warning goes.

    Regression: d260c06fa. The warning was raised outside the schedule-load
    warnings a reload retracts, and only a later sun computation with good
    coordinates removed it, so deleting the last sun entry left the banner
    up until fppd restarted.
    """
    fppd.settings(Latitude="N38.9", Longitude="W104.6")
    items(fppd, [entry(7, "SunSet", "23:00:00")], f"{YEAR}-06-10 12:00:00")
    fppd.wait_for(lambda: coordinates_flagged(fppd), timeout=10, what="the coordinates warning")
    fppd.write("config/schedule.json", [entry(7, "20:00:00", "21:00:00")])
    reload_schedule(fppd)
    fppd.wait_for(lambda: not coordinates_flagged(fppd), timeout=10,
                  what="the coordinates warning to come down with the last sun entry")


def test_coordinates_warning_comes_down_when_they_are_fixed(fppd):
    """Fixing Latitude/Longitude in settings takes the coordinates warning
    down without a schedule save or an fppd restart.

    Regression: d260c06fa. Sun times are only worked out on a schedule load,
    and nothing reloaded on a coordinates change, so the warning stayed until
    the next load (midnight, or a schedule save).
    """
    fppd.settings(Latitude="N38.9", Longitude="W104.6")
    items(fppd, [entry(7, "SunSet", "23:00:00")], f"{YEAR}-06-10 12:00:00")
    fppd.wait_for(lambda: coordinates_flagged(fppd), timeout=10, what="the coordinates warning")
    fppd.settings(Latitude="38.9", Longitude="-104.6")
    fppd.wait_for(lambda: not coordinates_flagged(fppd), timeout=10,
                  what="the coordinates warning to come down once they are fixed")
