"""Schedule entries that lean on defaults and limits: how far out odd/even
days are scheduled, dates left out of an entry, and the Limit of Extend
Schedule.

fppd's wall clock is faked (libfaketime) so the dates are fixed, and what it
has scheduled is read back from GET /fppd/schedule.
"""

import datetime
from zoneinfo import ZoneInfo

from show import status
from test_schedule_calendar import ODD_DAY, YEAR, ZONE, dint, entry, items

TZ = ZoneInfo(ZONE)
TODAY = datetime.date(YEAR, 6, 10)


def test_odd_day_entries_are_scheduled_as_far_out_as_the_setting(fppd):
    """An odd-days entry is scheduled out to ScheduleDistance days, not a
    fixed five weeks.

    Regression: fc5b676bc. The odd/even loop stopped at day 35 whatever
    the Max (ScheduleDistance) setting said, so a 60 day preview showed
    nothing past five weeks."""
    fppd.settings(ScheduleDistance="60")
    got = items(fppd, [entry(ODD_DAY, "20:00:00", "21:00:00")], f"{TODAY.isoformat()} 12:00:00")
    last = max(i["startDateInt"] for i in got)
    ahead = (datetime.datetime.strptime(str(last), "%Y%m%d").date() - TODAY).days
    assert ahead >= 50, f"odd-day entry scheduled only {ahead} days out (last {last}), with a 60 day distance"
    # and still only on odd days
    odd = {(datetime.datetime.strptime(str(i["startDateInt"]), "%Y%m%d").date()
            - datetime.date(2013, 7, 15)).days % 2 for i in got}
    assert odd == {1}, f"scheduled on {sorted(i['startDateInt'] for i in got)[:6]}"


def test_an_entry_without_dates_runs_on_every_date(fppd):
    """An entry that has no startDate or endDate is still scheduled, over a
    wide default range, rather than being refused.

    Regression: 119fe4c65. A missing or empty date was an error that
    dropped the whole entry (it used to take fppd down); it now falls back
    to 2019-01-01 and 2099-12-31."""
    bare = entry(7, "20:00:00", "21:00:00")
    del bare["startDate"]
    del bare["endDate"]
    empty = entry(7, "21:30:00", "22:00:00", startDate="", endDate="")
    got = items(fppd, [bare, empty], f"{TODAY.isoformat()} 12:00:00")
    for n in (0, 1):
        mine = [i for i in got if i["id"] == n]
        assert mine, f"entry {n} (no dates) was not scheduled: {got}"
        assert mine[0]["startDateInt"] == dint(TODAY)
    schedule = fppd.get("/fppd/schedule")["schedule"]
    assert status(fppd).get("fppd") == "running"
    assert [e["startDateInt"] for e in schedule["entries"]] == [20190101, 20190101] and \
        [e["endDateInt"] for e in schedule["entries"]] == [20991231, 20991231], schedule["entries"]


def test_extend_schedule_limit_only_moves_entries_due_within_it(fppd):
    """Extend Schedule with a Limit moves the entries due within that many
    seconds and leaves later ones where they were.

    Regression: b50bcbc35 (the optional Limit argument). Without the
    threshold test every future entry moved by the extension."""
    fppd.write("playlists/Show.json", {"name": "Show", "repeat": 1, "loopCount": 0,
                                       "leadIn": [], "leadOut": [],
                                       "mainPlaylist": [{"type": "pause", "enabled": 1,
                                                         "playOnce": 0, "duration": 600}]})
    day = TODAY.isoformat()
    fppd.write("config/schedule.json", [
        entry(7, "12:00:00", "13:00:00"),
        entry(7, "12:30:00", "12:45:00"),   # due within the hour
        entry(7, "15:00:00", "15:30:00"),   # not for three hours
    ])
    fppd.start(fake_time=f"{day} 12:00:05", tz=ZONE)
    fppd.wait_for(lambda: status(fppd).get("status_name") == "playing", timeout=15,
                  what="the scheduled playlist to start")

    def starts():
        got = {}
        for i in fppd.get("/fppd/schedule")["schedule"]["items"]:
            if i["startDateInt"] == dint(TODAY):
                got[i["id"]] = datetime.datetime.fromtimestamp(i["startTime"], TZ).strftime("%H:%M")
        return got
    assert starts() == {0: "12:00", 1: "12:30", 2: "15:00"}, starts()
    fppd.command("Extend Schedule", "300", "3600")
    fppd.wait_for(lambda: starts().get(1) == "12:35", timeout=10,
                  what="the entry due within the limit to move 5 minutes later")
    assert starts()[2] == "15:00", f"an entry due in three hours moved: {starts()}"
