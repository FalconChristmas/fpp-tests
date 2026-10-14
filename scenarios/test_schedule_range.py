"""The calendar's view of the schedule (GET /fppd/schedule/range) against an
independent expansion of the same entries, done here in Python: every day
type, a window past midnight, a repeating command, across the November
clock change -- and against the scheduler's own plan (GET /fppd/schedule),
which is a separate expansion of the same file."""

import datetime

import pytest

from test_holidays import show
from test_schedule_calendar import YEAR, ZONE, entry
from zoneinfo import ZoneInfo

TZ = ZoneInfo(ZONE)
EPOCH = datetime.date(2013, 7, 15)  # FPP's odd/even day epoch

# weekday() numbers: Monday 0 .. Sunday 6
DAYS = {
    7: set(range(7)), 8: {0, 1, 2, 3, 4}, 9: {5, 6}, 10: {0, 2, 4}, 11: {1, 3},
    12: {6, 0, 1, 2, 3}, 13: {4, 5}, 3: {2},
    0x10000 | 0x01000 | 0x00100: {1, 5},  # a custom mask: Tuesday and Saturday
}


def on_day(day_index, d):
    if day_index in (14, 15):
        odd = (d - EPOCH).days % 2 == 1
        return odd == (day_index == 14)
    return d.weekday() in DAYS[day_index]


def local(d, hms):
    h, m, s = map(int, hms.split(":"))
    return int(datetime.datetime(d.year, d.month, d.day, h, m, s, tzinfo=TZ).timestamp())


def expand(entries, first, last):
    """Occurrences (entry index, start, end) of entries on days first..last."""
    out = set()
    d = first
    while d <= last:
        for i, e in enumerate(entries):
            if not on_day(e["day"], d):
                continue
            start, end = local(d, e["startTime"]), local(d, e["endTime"])
            if end < start:  # past midnight: ends the next day
                end = local(d + datetime.timedelta(days=1), e["endTime"])
            step = (e["repeat"] // 100) * 60 if not e["playlist"] else 0
            if step:
                t = start
                while t < end:
                    out.add((i, t, t))  # a command is a point in time
                    t += step
            else:
                out.add((i, start, end))
        d += datetime.timedelta(days=1)
    return out


def entries():
    e = []
    for k, day in enumerate([7, 8, 9, 10, 11, 12, 13, 14, 15, 3, 0x10000 | 0x01000 | 0x00100]):
        e.append(entry(day, f"{6 + k:02d}:00:00", f"{6 + k:02d}:30:00", repeat=0))
    e.append(entry(7, "23:30:00", "00:45:00", repeat=0))  # past midnight
    e.append(entry(7, "05:00:00", "06:00:00", playlist="", command="Set Variable",
                   args=["X", "Value", "1"], repeat=1500))  # every 15 minutes
    return e


def fall_back():
    d = datetime.date(YEAR, 11, 1)
    return d + datetime.timedelta(days=(6 - d.weekday()) % 7)  # first Sunday


def test_calendar_range_matches_the_schedule(fppd):
    """Every occurrence the calendar shows for a week is one the entries
    really have -- no more, no fewer, at the right instants -- including on
    the 25-hour day."""
    sched = entries()
    sunday = fall_back()
    first = sunday - datetime.timedelta(days=4)  # the Wednesday before
    last = first + datetime.timedelta(days=7)
    show(fppd)
    fppd.write("config/schedule.json", sched)
    fppd.start(fake_time=f"{first.isoformat()} 03:00:00", tz=ZONE)
    r0, r1 = local(first, "00:00:00"), local(last, "00:00:00")
    got = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}")["schedule"]["items"]
    shown = {(i["id"], i["startTime"], i["endTime"]) for i in got}
    want = {o for o in expand(sched, first - datetime.timedelta(days=1), last)
            if o[2] >= r0 and o[1] <= r1}
    missing, extra = sorted(want - shown), sorted(shown - want)
    assert not missing and not extra, f"missing {missing[:5]}, extra {extra[:5]}"


def test_calendar_day_summary_counts(fppd):
    """The month view's day summary: one item per entry per day, with the
    repeating command's four occurrences counted."""
    sched = entries()
    first = fall_back() - datetime.timedelta(days=4)
    show(fppd)
    fppd.write("config/schedule.json", sched)
    fppd.start(fake_time=f"{first.isoformat()} 03:00:00", tz=ZONE)
    r0, r1 = local(first, "00:00:00"), local(first, "23:59:59")
    got = fppd.get(f"/fppd/schedule/range?start={r0}&end={r1}&summary=1")["schedule"]["items"]
    cmd = [i for i in got if i["id"] == len(sched) - 1 and i["startDateInt"] == int(first.strftime("%Y%m%d"))]
    assert len(cmd) == 1 and cmd[0]["count"] == 4, cmd


@pytest.mark.parametrize("query", ["start=0&end=10", "start=100&end=50",
                                   "start=1000&end=999999999", "start=abc&end=def", ""])
def test_calendar_range_bad_queries_are_400(fppd, query):
    """A range that is empty, backwards or over 420 days is refused."""
    import urllib.error
    fppd.start()
    with pytest.raises(urllib.error.HTTPError) as e:
        fppd.get("/fppd/schedule/range?" + query)
    assert e.value.code == 400


def test_the_schedulers_plan_matches_the_calendar(fppd):
    """What the scheduler plans to start over the next two days is what the
    calendar shows for them: two expansions of one schedule.json. The two
    days span the fall-back Sunday. (Further out the plan is deliberately
    thinner -- repeating entries stop at a two-day horizon, odd/even days
    at the end of the ScheduleDistance week count -- and it is rebuilt every
    midnight.)"""
    sched = entries()
    saturday = fall_back() - datetime.timedelta(days=1)
    show(fppd)
    fppd.write("config/schedule.json", sched)
    fppd.start(fake_time=f"{saturday.isoformat()} 03:00:00", tz=ZONE)
    now = local(saturday, "03:00:00")
    horizon = now + 2 * 86400 - 1
    plan = fppd.get("/fppd/schedule")["schedule"]["items"]
    planned = {(i["id"], i["startTime"]) for i in plan if now <= i["startTime"] <= horizon}
    got = fppd.get(f"/fppd/schedule/range?start={now}&end={horizon}")["schedule"]["items"]
    shown = {(i["id"], i["startTime"]) for i in got if now <= i["startTime"] <= horizon}
    assert planned == shown, (f"planned only: {sorted(planned - shown)[:5]}, "
                              f"shown only: {sorted(shown - planned)[:5]}")
    assert len(planned) > 10, planned
