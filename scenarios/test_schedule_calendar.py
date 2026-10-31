"""Scheduler date and time arithmetic on the days that break it: DST
changes, past-midnight windows, odd/even days.

fppd's wall clock is faked (libfaketime) to the day in question, and the
times it computes are read back from GET /fppd/schedule -- the items it has
scheduled, with epoch start and end times -- so nothing waits for real time.
"""

import datetime
import time
from zoneinfo import ZoneInfo

from fseq import solid_frames
from show import CHANNELS, install, status

ZONE = "America/New_York"
TZ = ZoneInfo(ZONE)
ODD_DAY, EVEN_DAY, SUNDAY, EVERY_DAY = 14, 15, 0, 7

# Next year: fppd holds its scheduler back while the clock reads earlier than
# its own build ("clock appears incorrect"), so faked dates must be later.
YEAR = datetime.date.today().year + 1


def nth_sunday(month, n):
    d = datetime.date(YEAR, month, 1)
    d += datetime.timedelta(days=(6 - d.weekday()) % 7)
    return d + datetime.timedelta(weeks=n - 1)


FALL_BACK = nth_sunday(11, 1)      # US: first Sunday in November
SPRING_FORWARD = nth_sunday(3, 2)  # US: second Sunday in March


def entry(day, start, end, **extra):
    e = {"enabled": 1, "day": day, "playlist": "Show", "startTime": start, "endTime": end,
         "startDate": f"{YEAR}-01-01", "endDate": f"{YEAR}-12-31", "repeat": 1, "stopType": 0}
    e.update(extra)
    return e


def at(day, clock):
    return f"{day.isoformat()} {clock}"


def dint(day):
    return int(day.strftime("%Y%m%d"))


def items(fppd, schedule, now):
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0,
                                       "leadIn": [], "leadOut": [], "mainPlaylist": []})
    fppd.write("config/schedule.json", schedule)
    fppd.start(fake_time=now, tz=ZONE)
    return fppd.get("/fppd/schedule")["schedule"]["items"]


def local(day, h, mi):
    return int(datetime.datetime(day.year, day.month, day.day, h, mi, tzinfo=TZ).timestamp())


def test_past_midnight_end_on_the_fall_back_day(fppd):
    """A Sunday 17:00-00:30 entry on the day clocks fall back ends at 00:30
    the next morning, not 23:30.

    Regression: aca20c989. The next-day end was the start day's end time
    plus 86400 s, an hour short across the change."""
    got = items(fppd, [entry(SUNDAY, "17:00:00", "00:30:00")], at(FALL_BACK, "08:00:00"))
    first = got[0]
    monday = FALL_BACK + datetime.timedelta(days=1)
    assert first["startTime"] == local(FALL_BACK, 17, 0), first["startTimeStr"]
    assert first["endTime"] == local(monday, 0, 30), \
        f"ends {first['endTimeStr']}, expected {monday} 00:30"


def test_start_in_the_spring_forward_gap(fppd):
    """A 02:30-03:00 entry on the day clocks spring forward (02:30 doesn't
    exist that day) runs for at most its half hour, not most of a day.

    Regression: aca20c989. mktime moved the 02:30 start to 03:30, which then
    looked later than the 03:00 end, so the entry was taken to cross midnight
    and ran for 23.5 hours."""
    got = items(fppd, [entry(EVERY_DAY, "02:30:00", "03:00:00")], at(SPRING_FORWARD, "00:30:00"))
    today = [i for i in got if i["startDateInt"] == dint(SPRING_FORWARD)]
    assert today, f"nothing scheduled on the spring-forward day: {[i['startTimeStr'] for i in got[:3]]}"
    length = today[0]["endTime"] - today[0]["startTime"]
    assert 0 <= length <= 1800, \
        f"{today[0]['startTimeStr']} to {today[0]['endTimeStr']}: {length / 3600:.1f} h"


def test_odd_day_entry_just_after_midnight_in_summer(fppd):
    """An odd-days entry, scheduled from just after midnight in DST, lands on
    odd days -- counted in calendar days since 2013-07-15.

    Regression: 3d99e116d. The count used seconds from an epoch built with
    tm_isdst=0; from 00:00 to 00:59 in summer (when the midnight reload runs)
    it came out a day short, so odd entries went on even days."""
    day = datetime.date(YEAR, 7, 10)
    if (day - datetime.date(2013, 7, 15)).days % 2 == 0:
        day += datetime.timedelta(days=1)  # an odd day, in DST
    got = items(fppd, [entry(ODD_DAY, "20:00:00", "21:00:00")], at(day, "00:30:00"))
    dates = [i["startDateInt"] for i in got[:3]]
    expected = [dint(day), dint(day + datetime.timedelta(days=2))]
    assert dates[:2] == expected, f"odd-day entry scheduled on {dates}, expected {expected}"


def test_commands_after_the_clock_steps_back(fppd):
    """A player that boots with its clock ahead and is then stepped back (NTP
    correcting an RTC that held the wrong time) still runs what is scheduled
    in the span it stepped back over, when that time comes round.

    Regression: aa8dc0b15. Items already passed at the wrong, later time
    stayed marked as ran and the command check window stayed ahead of the
    clock, so a scheduled command at 20:30 never ran after a step from
    22:00 back to 20:29.

    Regression: 0c2626a55 (its Scheduler half). The time delta was taken
    after the last-processed time had been overwritten, so a step back was
    never seen as one."""
    day = datetime.date(YEAR, 6, 1)
    command = entry(EVERY_DAY, "20:30:00", "20:30:00", playlist="", command="Set Variable",
                    args=["Ran", "Value", "yes", "1", "0", "100", ""],
                    multisyncCommand=False, multisyncHosts="", repeat=0)
    fppd.write("config/schedule.json", [command])
    fppd.start(fake_time=at(day, "22:00:00"), tz=ZONE)
    time.sleep(3)
    fppd.set_clock(at(day, "20:29:45"))
    fppd.wait_for(lambda: (fppd.get("/variables") or {}).get("Ran", {}).get("value") == "yes",
                  timeout=45, interval=1, what="the 20:30 command to run after the clock stepped back")


def fppd_clock(fppd):
    """fppd's (faked) local wall clock, to the second, from its status."""
    words = fppd.get("/fppd/status")["time"].split()  # "Tue Jun 01 20:29:02 EDT 2027"
    return datetime.datetime.strptime(" ".join(words[:4] + words[5:]), "%a %b %d %H:%M:%S %Y")


def crossover_at_sunday_half_past_midnight(fppd, day):
    """The status a 22:00-02:00 entry for `day` leaves fppd in at 00:30 on a
    Sunday, after a few seconds to start anything it is going to."""
    install(fppd, solid_frames(40, CHANNELS, 55))
    fppd.write("config/schedule.json", [entry(day, "22:00:00", "02:00:00")])
    fppd.start(fake_time=at(nth_sunday(6, 1), "00:30:00"), tz=ZONE)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and status(fppd).get("status_name") != "playing":
        time.sleep(0.25)
    return status(fppd)


def test_monday_night_crossover_does_not_play_early_sunday(fppd):
    """A Monday-only 22:00-02:00 entry doesn't play at 00:30 on a Sunday.

    Regression: 921616bb5. On Sundays the scheduler pushed yesterday's
    (Saturday's) occurrence of every entry that crosses midnight, whatever
    its days, so a Monday-only show played from Sunday 00:00 to 02:00."""
    s = crossover_at_sunday_half_past_midnight(fppd, 1)
    assert s.get("status_name") == "idle", \
        f"a Monday-only show is playing early Sunday: {s.get('current_playlist')}"


def test_saturday_night_crossover_plays_into_sunday(fppd):
    """A Saturday-only 22:00-02:00 entry is still playing at 00:30 on the
    Sunday. (The control for the Monday-only case: the fix for that one
    keeps this.)"""
    s = crossover_at_sunday_half_past_midnight(fppd, 6)
    assert s.get("status_name") == "playing", s


def test_a_command_whose_second_the_clock_steps_over_still_runs(fppd):
    """A scheduled command runs even when the scheduler never sees its exact
    second -- here the clock steps about 4 s, over a 20:30:00 command (a
    small NTP correction, or the scheduler's loop held up that long). Under
    5 s, so the step doesn't also reload the schedule.

    Regression: 921616bb5. A command ran only if a scheduler pass landed on
    its second; one already in the past was marked ran without running,
    silently (a 00:00:00 command behind the slow midnight reload, say)."""
    day = datetime.date(YEAR, 6, 1)
    command = entry(EVERY_DAY, "20:30:00", "20:30:00", playlist="", command="Set Variable",
                    args=["Ran", "Value", "yes", "1", "0", "100", ""],
                    multisyncCommand=False, multisyncHosts="", repeat=0)
    fppd.write("config/schedule.json", [command])
    fppd.start(fake_time=at(day, "20:29:00"), tz=ZONE)
    def step(clock):
        fppd.set_clock(at(day, clock))
        return fppd_clock(fppd)

    before = step("20:29:57")
    time.sleep(1)
    # The jump to 20:29:57 reloaded the schedule; the step under test must not.
    # Judged from fppd's log, not by differencing two status reads: a read
    # just after a step can come back a second short, which made a 4 s step
    # look like 6.
    reloads = fppd.log().count("Current Schedule:")
    after = step("20:30:02")
    assert before.time() < datetime.time(20, 30) < after.time(), \
        f"the step went from {before} to {after}, not over 20:30:00"
    fppd.wait_for(lambda: (fppd.get("/variables") or {}).get("Ran", {}).get("value") == "yes",
                  timeout=10, interval=0.5, what="the 20:30:00 command the clock stepped over")
    assert fppd.log().count("Current Schedule:") == reloads, \
        "the step reloaded the schedule, so the command may have run from the reload, not the stepped-over second"


def test_clock_stepping_forward_into_a_window_starts_its_playlist_once(fppd):
    """A player whose clock steps forward into an open schedule window (NTP
    correcting a clock that booted behind) starts the window's playlist
    within seconds, and starts it once.

    Coverage for 8174c3944, not a red check: it dropped ScheduleProc()'s own
    "time jumped forward" check, which called CheckIfShouldBePlayingNow() on
    top of CheckScheduledItems(); with the extra call restored the second
    one finds the playlist already playing and leaves it alone."""
    day = datetime.date(YEAR, 6, 1)
    count = {"type": "command", "enabled": 1, "playOnce": 0, "command": "Set Variable",
             "args": ["Starts", "Expression", "", "1", "0", "100", "=Starts+1", "false"]}
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 0, "loopCount": 0, "leadIn": [count],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1, "playOnce": 0,
                                                         "duration": 120}], "leadOut": []})
    fppd.write("config/schedule.json", [entry(EVERY_DAY, "20:00:00", "21:00:00",
                                              startDate=day.isoformat(), endDate=day.isoformat())])
    fppd.start(fake_time=at(day, "18:00:00"), tz=ZONE)
    time.sleep(3)
    assert fppd.get("/fppd/status").get("status_name") == "idle"
    fppd.command("Set Variable", "Starts", "Value", "0")
    fppd.set_clock(at(day, "20:30:00"))
    fppd.wait_for(lambda: fppd.get("/fppd/status").get("status_name") == "playing", timeout=10,
                  interval=0.5, what="the window's playlist after the step")
    time.sleep(5)
    starts = (fppd.get("/variables") or {}).get("Starts", {}).get("value")
    assert starts is not None and float(starts) == 1, f"the playlist started {starts} times"
