"""Extend Schedule with a Limit: the schedule's events within the next Limit
seconds are moved by the same amount."""

import time

from test_scheduler import playing, scheduled_show, status


def test_extending_does_not_move_the_start_of_the_run_in_progress(fppd):
    """With a Limit, Extend Schedule moves what is still to come; the
    scheduled playlist already running keeps its start, so the schedule shows
    one run of it, not that and a second one starting in the future.

    Regression: 8f1a4d91e. The start was moved whenever the limit lay ahead,
    for events already begun too, leaving a phantom run after the real one."""
    scheduled_show(fppd, -60, 600)
    fppd.start()
    fppd.wait_for(lambda: playing(fppd), timeout=30, interval=0.5, what="the scheduled playlist")
    before = [i["startTime"] for i in fppd.get("/fppd/schedule")["schedule"]["items"]]
    assert fppd.command("Extend Schedule", "120", "3600") == "Schedule Updated"
    time.sleep(4)  # the schedule reloads on the scheduler's next pass
    got = fppd.get("/fppd/schedule")["schedule"]["items"]
    assert [i["startTime"] for i in got] == before and len(before) == 1, \
        f"before {before}; after {[(i['startTimeStr'], i['endTimeStr']) for i in got]}"
    assert status(fppd).get("status_name") == "playing"
