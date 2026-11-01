"""Scheduler times for the days after a DST change, from before it."""

import datetime

from test_schedule_calendar import FALL_BACK, SPRING_FORWARD, entry, items, local, at


def check_week_after(fppd, change_day):
    """Faked to noon the day before the clocks change, a daily 19:00 entry is
    scheduled at 19:00 local on the change day and each of the next six."""
    eve = change_day - datetime.timedelta(days=1)
    got = {i["startTime"] for i in items(fppd, [entry(7, "19:00:00", "20:00:00")], at(eve, "12:00:00"))}
    for n in range(0, 7):
        day = change_day + datetime.timedelta(days=n)
        assert local(day, 19, 0) in got, \
            f"{day}: no 19:00 start; got {sorted(datetime.datetime.fromtimestamp(t).isoformat() for t in got)}"


def test_week_after_spring_forward_keeps_its_wall_clock_times(fppd):
    """Regression: 2d0e2c7b1 (#1151). A day's times were worked out by adding
    seconds to the week's Sunday, so every day past the change came out an
    hour off."""
    check_week_after(fppd, SPRING_FORWARD)


def test_week_after_fall_back_keeps_its_wall_clock_times(fppd):
    """Regression: 2d0e2c7b1 (#1151); the fall-back half of the above."""
    check_week_after(fppd, FALL_BACK)
