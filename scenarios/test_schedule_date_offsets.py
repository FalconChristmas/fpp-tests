"""Day offsets on holiday-anchored schedule dates ("7 days before
Thanksgiving", "Christmas + 2"), and schedule.json offsets fppd can't read.

As in test_holidays, fppd's clock is faked to the day in question and the
days it has scheduled are read back from GET /fppd/schedule.

Offsets are checked across several years, a leap year among them. Every
expected date is computed here (Thanksgiving is the fourth Thursday of
November, Memorial Day the last Monday of May, Labor Day the first Monday of
September, Easter by the anonymous Gregorian algorithm), not taken from fppd.

Two code paths resolve an offset, and both are checked:

- the live schedule (GET /fppd/schedule): LoadFromJson -> ResolveDate with
  no reference year, i.e. relative to fppd's (faked) clock, rolling forward
  to next year once the offset date has passed;
- the calendar (GET /fppd/schedule/range): GetDateRangeForYear, which
  re-resolves the holiday and its offset for each year it walks.

Holidays resolve to a yearless month and day, which DateInRange matches in
any year and wraps across December 31. So an offset that carries a date
into the next or previous year (Christmas +10, New Year's Day -3) stands for
that month and day: in a year's walk, "Christmas +10" is January 4 of that
same year.

Left out, as fpp gets it wrong (PROBLEMS.md #21 and #12):

- A floating holiday whose offset crosses the year boundary is resolved
  against the wrong year's holiday on the far side of it: "Thanksgiving +40"
  from Thanksgiving 2027 (November 25) should run to January 4, 2028, but in
  January 2028 both paths compute it from Thanksgiving 2028 (November 23)
  and stop on January 2. Only fixed holidays (Christmas, New Year's Day)
  are used here across the year boundary.
- Diwali, the commit's own roll-forward example, is not used: its date comes
  only from fppd's lookup table, and a lunar holiday that has passed rolls
  to next year's yearless month and day, which this year also matches
  (PROBLEMS.md #12), so an exact set of days can't be asserted for it.
  Thanksgiving goes through the same ResolveDate roll-forward logic.
"""

import datetime

import pytest

from show import status
from test_holidays import scheduled_days, show
from test_schedule_calendar import TZ, YEAR, ZONE, entry
from test_schedule_config import easter, warnings

DAY = datetime.timedelta(days=1)


def thanksgiving(year):
    d = datetime.date(year, 11, 1)
    d += datetime.timedelta(days=(3 - d.weekday()) % 7)  # first Thursday
    return d + datetime.timedelta(weeks=3)


def scheduled(fppd, entries, today):
    show(fppd)
    fppd.settings(Locale="USA")
    fppd.write("config/schedule.json", entries)
    fppd.start(fake_time=f"{today.isoformat()} 12:00:00", tz=ZONE)
    return scheduled_days(fppd)


def test_start_offset_before_a_holiday(fppd):
    """A schedule from "Thanksgiving" with a start offset of -7 days to
    Christmas is running five days before Thanksgiving.

    Feature: 3db2b02d6."""
    tg = thanksgiving(YEAR)
    today = tg - datetime.timedelta(days=5)
    days = scheduled(fppd, [entry(7, "19:00:00", "20:00:00", startDate="Thanksgiving",
                                  startDateOffset=-7, endDate="Christmas")], today)
    assert today in days, f"Thanksgiving {YEAR} is {tg}; scheduled from {min(days, default=None)}"


def test_end_offset_after_a_holiday(fppd):
    """A schedule to "Christmas" with an end offset of +2 days still runs on
    December 26 and 27, and not on the 28th.

    Feature: 3db2b02d6. With an offset, the range rolls on to next year only
    once the offset date has passed, not the holiday itself."""
    today = datetime.date(YEAR, 12, 26)
    days = scheduled(fppd, [entry(7, "19:00:00", "20:00:00", startDate="Thanksgiving",
                                  endDate="Christmas", endDateOffset=2)], today)
    this_year = {d for d in days if d.year == YEAR}
    assert this_year == {today, today + datetime.timedelta(days=1)}, sorted(days)[:5]


def test_malformed_date_offset_counts_as_zero(fppd):
    """Date offsets that aren't numbers -- an object, an array, a fraction --
    don't stop fppd loading the schedule: each such entry is scheduled with
    no offset, with a warning naming the field. A null offset is no offset.

    Regression: aabdc187a. The offsets were read with asLargestInt(), which
    throws on an object or an array, so fppd died loading the schedule (and
    again on every restart); since 903dc31e6 the entry is skipped instead,
    which is still wrong: it is the offset that is bad, not the entry."""
    today = datetime.date(YEAR, 6, 10)
    bad = [{"x": 1}, [1], 1.5]
    entries = [entry(7, f"{18 + i}:00:00", f"{18 + i}:30:00", startDate=f"{YEAR}-06-01",
                     startDateOffset=v, endDateOffset=None) for i, v in enumerate(bad)]
    show(fppd)
    fppd.write("config/schedule.json", entries)
    fppd.start(fake_time=f"{today.isoformat()} 12:00:00", tz=ZONE)
    from zoneinfo import ZoneInfo
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    starts = {datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).strftime("%H:%M")
              for i in got if datetime.datetime.fromtimestamp(i["startTime"], ZoneInfo(ZONE)).date() == today}
    assert starts == {"18:00", "19:00", "20:00"}, (starts, status(fppd).get("warnings"))
    assert any("startDateOffset is not a number" in w for w in status(fppd).get("warnings", [])), \
        status(fppd).get("warnings")


def memorial_day(year):
    """US Memorial Day: the last Monday of May."""
    last = datetime.date(year, 5, 31)
    return last - datetime.timedelta(days=last.weekday())


def labor_day(year):
    """US Labor Day: the first Monday of September."""
    first = datetime.date(year, 9, 1)
    return first + datetime.timedelta(days=-first.weekday() % 7)


def fixed(month, day):
    return lambda year: datetime.date(year, month, day)


# (holiday shortName, its date in a year, day offset). The holiday names are
# the USA locale's.
CASES = [
    ("Thanksgiving", thanksgiving, -7),        # the Thursday before
    ("Christmas", fixed(12, 25), 2),           # December 27
    ("MemorialDay", memorial_day, -3),         # a "tail" holiday: the Friday before
    ("LaborDay", labor_day, -7),               # back across the month, into August
    ("Easter", easter, -46),                   # Ash Wednesday, across one or two months
    ("NewYearsDay", fixed(1, 1), 59),          # March 1, or February 29 in a leap year
    ("Christmas", fixed(12, 25), 10),          # January 4 of the next year
    ("NewYearsDay", fixed(1, 1), -3),          # December 29 of the year before
    ("NewYearsDay", fixed(1, 1), 366),         # the upper bound
    ("NewYearsDay", fixed(1, 1), -366),        # the lower bound
]


def on_day(name, offset, start="19:00:00", end="20:00:00", **extra):
    """An every-day entry whose start and end date are both `name` shifted
    by `offset` days: it runs on that one day."""
    e = entry(7, start, end, startDate=name, endDate=name,
              startDateOffset=offset, endDateOffset=offset)
    e.update(extra)
    return e


def expected_in(year, holiday, offset):
    """The day in `year` an entry on `holiday` + `offset` runs on. The
    offset is applied in that year (so leap days count) and the result is
    a month and day, which matches in whatever year it is checked in."""
    d = holiday(year) + datetime.timedelta(days=offset)
    return datetime.date(year, d.month, d.day)


def local_midnight(day):
    return int(datetime.datetime(day.year, day.month, day.day, tzinfo=TZ).timestamp())


def range_days(fppd, first, last):
    """{entry id: the set of days it runs on} from first to last inclusive,
    from the calendar's /fppd/schedule/range."""
    got = fppd.get(f"/fppd/schedule/range?start={local_midnight(first)}"
                   f"&end={local_midnight(last + DAY) - 1}")["schedule"]["items"]
    days = {}
    for i in got:
        days.setdefault(i["id"], set()).add(
            datetime.datetime.fromtimestamp(i["startTime"], TZ).date())
    return days


def live_days(fppd):
    """{entry id: the set of days it runs on} from the live schedule."""
    days = {}
    for i in fppd.get("/fppd/schedule")["schedule"]["items"]:
        days.setdefault(i["id"], set()).add(
            datetime.datetime.fromtimestamp(i["startTime"], TZ).date())
    return days


def warning_ids(fppd, text):
    return [w.get("id") for w in fppd.get("/fppd/warnings_full") if text in w.get("message", "")]


def entries(fppd):
    return fppd.get("/fppd/schedule")["schedule"]["entries"]


# The next five years, and the next year of each shape 557a9d4fd broke: a
# month that starts on its holiday's weekday (November 1 a Thursday for
# Thanksgiving, September 1 a Monday for Labor Day). Picked from the date,
# not written in, so the five-year window moving on never drops them.
FIRST_DAY_YEARS = [next(y for y in range(YEAR, YEAR + 15) if datetime.date(y, month, 1).weekday() == wday)
                   for month, wday in ((11, 3), (9, 0))]
YEARS = sorted({YEAR + n for n in range(5)} | set(FIRST_DAY_YEARS))

# Not a check of fppd: in at least one of the years, each case has to run on
# a different day than its holiday does (New Year's Day + 366 is January 1
# again in a leap year).
for _name, _holiday, _offset in CASES:
    assert any(expected_in(y, _holiday, _offset) != expected_in(y, _holiday, 0) for y in YEARS), _name
assert any(y % 4 == 0 for y in YEARS), "no leap year among the years checked"


@pytest.mark.parametrize("year", YEARS, ids=[f"{y}{'-leap' if y % 4 == 0 else ''}" for y in YEARS])
def test_holiday_with_an_offset_runs_on_the_shifted_day(fppd, year):
    """Each entry in CASES runs on its holiday shifted by its offset, and on
    no other day of the year: in the live schedule (fppd's clock at January
    1 of that year, scheduling a year ahead; checked through November) and
    in the calendar's walk of the whole year. The years include a leap
    year, where New Year's Day + 59 is February 29 and the +-366 bounds
    land a day apart from other years. A literal YYYY-MM-DD date ignores
    its offset, and the offsets are echoed back in the schedule's entries.

    Feature: 3db2b02d6.

    Also 8914969c9: ScheduleDistance="365" is what lets the live schedule
    reach a holiday months ahead (with the weekly loop held to 28 days, the
    November holidays are missing from it).

    Regression: 557a9d4fd. A first-/second-... weekday holiday in a month
    that starts on that weekday was put a week late (Thanksgiving in a year
    whose November 1 is a Thursday, Labor Day in one whose September 1 is a
    Monday; FIRST_DAY_YEARS keeps one of each among the years)."""
    show(fppd)
    fppd.settings(Locale="USA", ScheduleDistance="365")
    schedule = [on_day(name, offset) for name, _, offset in CASES]
    literal = datetime.date(year, 7, 4)
    schedule.append(on_day(literal.isoformat(), 5))
    fppd.write("config/schedule.json", schedule)
    fppd.start(fake_time=f"{year}-01-01 12:00:00", tz=ZONE)

    want = {i: {expected_in(year, holiday, offset)} for i, (_, holiday, offset) in enumerate(CASES)}
    want[len(CASES)] = {literal}
    # The live schedule reaches about a year ahead, depending on the weekday,
    # so it is compared up to the end of November.
    live_end = datetime.date(year, 11, 30)
    live = {i: {d for d in days if d.year == year and d <= live_end} for i, days in live_days(fppd).items()}
    cal = range_days(fppd, datetime.date(year, 1, 1), datetime.date(year, 12, 31))
    for i, w in want.items():
        name, offset = schedule[i]["startDate"], schedule[i]["startDateOffset"]
        lw = {d for d in w if d <= live_end}
        assert live.get(i, set()) == lw, \
            f"live schedule {year} to {live_end}: {name} {offset:+d} should run on {sorted(lw)}; " \
            f"runs on {sorted(live.get(i, ()))}"
        assert cal.get(i) == w, \
            f"calendar {year}: {name} {offset:+d} should run on {sorted(w)}; runs on {sorted(cal.get(i, ()))}"

    got = entries(fppd)
    assert [(e["startDateOffset"], e["endDateOffset"]) for e in got] == \
        [(e["startDateOffset"], e["endDateOffset"]) for e in schedule], got


@pytest.mark.parametrize("year", [YEAR, YEAR + 1])
def test_offset_range_across_new_year(fppd, year):
    """A range from New Year's Day - 3 to Christmas + 10 runs every day from
    December 29 to January 4, across the year boundary, and not outside it:
    in the live schedule with the clock at December 27, and in the calendar
    from December 1 to January 31.

    Feature: 3db2b02d6."""
    show(fppd)
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate="NewYearsDay", startDateOffset=-3,
                                              endDate="Christmas", endDateOffset=10)])
    fppd.start(fake_time=f"{year}-12-27 12:00:00", tz=ZONE)
    first = datetime.date(year + 1, 1, 1) - 3 * DAY
    last = datetime.date(year, 12, 25) + 10 * DAY
    want = {first + n * DAY for n in range((last - first).days + 1)}
    assert len(want) == 7, sorted(want)
    days = scheduled_days(fppd)
    assert days == want, f"should run {first} to {last}; runs on {sorted(days)}"
    cal = range_days(fppd, datetime.date(year, 12, 1), datetime.date(year + 1, 1, 31))
    assert cal.get(0) == want, f"calendar: should run {first} to {last}; runs on {sorted(cal.get(0, ()))}"


# Years whose Thanksgiving + 7 is in December, so that on December 1 a bare
# Thanksgiving has already rolled forward to next year (fppd rolls a
# "fourth Thursday of November" holiday forward once November is over).
ROLL_YEARS = [y for y in range(YEAR, YEAR + 12) if (thanksgiving(y) + 7 * DAY).month == 12][:3]


@pytest.mark.parametrize("year", ROLL_YEARS)
def test_offset_window_keeps_running_after_its_holiday(fppd, year):
    """A Thanksgiving to Thanksgiving + 7 entry, with fppd (re)started on
    December 1, still runs the days left in the window: from December 1 to
    Thanksgiving + 7, and nothing else in the next four weeks.

    fppd resolves "Thanksgiving + 7" in this year and only rolls it to next
    year once that day has passed. Taken from next year's Thanksgiving, as a
    bare Thanksgiving is by then, it would end in November and the rest of
    this year's window would be dropped.

    Feature: 3db2b02d6."""
    assert len(ROLL_YEARS) == 3, ROLL_YEARS
    end = thanksgiving(year) + 7 * DAY
    now = datetime.date(year, 12, 1)
    # Not a check of fppd: the window taken from next year's Thanksgiving
    # has to give a different answer, or this would prove nothing.
    rolled = thanksgiving(year + 1) + 7 * DAY
    rolled = datetime.date(year, rolled.month, rolled.day)
    assert {now + n * DAY for n in range((rolled - now).days + 1)} != \
        {now + n * DAY for n in range((end - now).days + 1)}
    show(fppd)
    fppd.settings(Locale="USA")
    fppd.write("config/schedule.json", [entry(7, "19:00:00", "20:00:00",
                                              startDate="Thanksgiving",
                                              endDate="Thanksgiving", endDateOffset=7)])
    fppd.start(fake_time=f"{now.isoformat()} 12:00:00", tz=ZONE)
    want = {now + n * DAY for n in range((end - now).days + 1)}
    days = scheduled_days(fppd)
    assert days == want, f"Thanksgiving {year} + 7 is {end}; from {now} runs on {sorted(days)}"


OUT_OF_RANGE = [367, -367, 10 ** 12, "400"]


def test_offset_out_of_range_is_ignored_with_a_warning(fppd):
    """An offset outside -366..366 days (367, -367, 10^12, or "400" as a
    string) is ignored: the entry runs on its holiday itself, its offset
    reads back as 0, and warning 47 says which offset was out of range. An
    offset given as a string ("-7") is read as a number.

    Feature: 3db2b02d6."""
    show(fppd)
    fppd.settings(Locale="USA")
    schedule = [on_day("NewYearsDay", 0, startDateOffset=v) for v in OUT_OF_RANGE] + \
               [on_day("NewYearsDay", 0, endDateOffset=v) for v in OUT_OF_RANGE] + \
               [on_day("Thanksgiving", "-7")]
    fppd.write("config/schedule.json", schedule)
    fppd.start(fake_time=f"{YEAR}-01-01 12:00:00", tz=ZONE)
    cal = range_days(fppd, datetime.date(YEAR, 1, 1), datetime.date(YEAR, 12, 31))
    got = entries(fppd)
    for i, e in enumerate(schedule[:-1]):
        assert cal.get(i) == {datetime.date(YEAR, 1, 1)}, \
            f"entry {i} ({e['startDateOffset']!r}, {e['endDateOffset']!r}) runs on {sorted(cal.get(i, ()))}"
        assert (got[i]["startDateOffset"], got[i]["endDateOffset"]) == (0, 0), got[i]
    tg = len(schedule) - 1
    assert cal.get(tg) == {thanksgiving(YEAR) - 7 * DAY}, \
        f"Thanksgiving {YEAR} - 7 is {thanksgiving(YEAR) - 7 * DAY}; runs on {sorted(cal.get(tg, ()))}"
    assert (got[tg]["startDateOffset"], got[tg]["endDateOffset"]) == (-7, -7), got[tg]
    for key in ("startDateOffset", "endDateOffset"):
        assert warning_ids(fppd, f"{key} out of range") == [47], fppd.get("/fppd/warnings_full")


# What JSON types other than a whole number or a string do (aabdc187a reads
# with isIntegral() first): null is 0 without a word; anything else that is
# not a whole number -- including a bool, which jsoncpp's isIntegral() calls
# not integral -- is ignored with warning 47. A whole-number double counts.
# (offset, days after Christmas it runs, warns)
TYPES = [(1.5, 0, True), (True, 0, True), (False, 0, True), (None, 0, False), (2.0, 2, False)]


@pytest.mark.parametrize("value, shift, warns", TYPES,
                         ids=["1.5", "true", "false", "null", "2.0"])
def test_offset_that_is_not_a_whole_number(fppd, value, shift, warns):
    """A date offset of 1.5, true or false is ignored with warning 47
    ("is not a number"), null is taken as 0 without one, and 2.0 is 2: the
    entry runs on Christmas plus that, and fppd keeps running.

    Since aabdc187a. (None of these aborted fppd before it: jsoncpp's
    asLargestInt() takes a fractional double, a bool or null without
    throwing. So this isn't the regression check;
    test_malformed_offset_does_not_abort_fppd is.)"""
    show(fppd)
    fppd.write("config/schedule.json",
               [entry(7, "19:00:00", "20:00:00", startDate="Christmas", endDate="Christmas",
                      startDateOffset=value, endDateOffset=value)])
    fppd.start(fake_time=f"{YEAR}-12-15 12:00:00", tz=ZONE)
    want = {datetime.date(YEAR, 12, 25) + shift * DAY}
    days = scheduled_days(fppd)
    assert days == want, f"offset {value!r}: should run on {sorted(want)}; runs on {sorted(days)}"
    got = entries(fppd)[0]
    assert (got["startDateOffset"], got["endDateOffset"]) == (shift, shift), got
    for key in ("startDateOffset", "endDateOffset"):
        assert warning_ids(fppd, f"{key} is not a number") == ([47] if warns else []), \
            fppd.get("/fppd/warnings_full")


def test_offset_too_big_for_an_integer_counts_as_zero(fppd):
    """An entry whose date offset is a double too big for an integer (1e300)
    loads with that offset taken as 0 and warning 47 ("is not a number"):
    fppd keeps running and schedules the entry on its date, here a literal
    one. (test_malformed_date_offset_counts_as_zero covers an object, an
    array and a fraction.)

    Regression: aabdc187a. The offset was read with asLargestInt(), which
    throws on a double out of Int64 range; nothing caught it, so fppd
    aborted at schedule load, and again on every restart."""
    key, value = "startDateOffset", 1e300
    day = datetime.date(YEAR, 6, 12)
    show(fppd)
    e = entry(7, "19:00:00", "20:00:00", startDate=day.isoformat(), endDate=day.isoformat())
    e[key] = value
    fppd.write("config/schedule.json", [e])
    fppd.start(fake_time=f"{YEAR}-06-10 12:00:00", tz=ZONE)
    days = scheduled_days(fppd)
    assert days == {day}, f"should run on {day}; runs on {sorted(days)}"
    assert entries(fppd)[0][key] == 0, entries(fppd)[0]
    assert any(f"{key} is not a number" in w for w in warnings(fppd)), warnings(fppd)
