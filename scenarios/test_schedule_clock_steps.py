"""Scheduled FPP commands when the clock is stepped back: a step of a few
minutes runs what it stepped over, and a shorter one doesn't run a command a
second time.

fppd's wall clock is faked (libfaketime) and stepped with fppd.set_clock().
"""

import datetime

from test_command_presets import variable
from test_schedule_calendar import EVERY_DAY, YEAR, ZONE, at, entry, fppd_clock

DAY = datetime.date(YEAR, 6, 1)


def command_at(clock, *args):
    return entry(EVERY_DAY, clock, clock, playlist="", command="Set Variable", args=list(args),
                 multisyncCommand=False, multisyncHosts="", repeat=0)


def test_a_step_back_of_minutes_runs_what_it_stepped_over(fppd):
    """A step back of two minutes is a step back like any larger one: the
    command in the span it stepped over runs when its second comes round."""
    fppd.write("config/schedule.json", [command_at("20:30:00", "Ran", "Value", "yes", "1", "0", "100", "")])
    fppd.start(fake_time=at(DAY, "20:32:00"), tz=ZONE)
    assert variable(fppd, "Ran") is None, "the 20:30 command ran at 20:32, before the step"
    fppd.set_clock(at(DAY, "20:29:50"))
    fppd.wait_for(lambda: variable(fppd, "Ran") == "yes", timeout=45, interval=0.5,
                  what="the 20:30 command to run after the clock stepped back")


def test_a_short_step_back_does_not_run_a_command_twice(fppd):
    """A step back shorter than the catch-up cap leaves the command check
    window where it was, so the command that ran seconds ago doesn't run again
    when its second comes round, though the reload has cleared its ran flag."""
    fppd.write("config/schedule.json", [
        command_at("20:00:20", "Ran", "Expression", "", "1", "0", "100", "=Ran+1", "false")])
    fppd.start(fake_time=at(DAY, "20:00:00"), tz=ZONE)
    fppd.command("Set Variable", "Ran", "Value", "0", "1", "0", "100", "")
    fppd.wait_for(lambda: float(variable(fppd, "Ran")) == 1, timeout=40, interval=0.25,
                  what="the 20:00:20 command to run")
    fppd.set_clock(at(DAY, "20:00:05"))
    fppd.wait_for(lambda: fppd_clock(fppd).time() >= datetime.time(20, 0, 24), timeout=40, interval=0.5,
                  what="the clock to come back round past 20:00:20")
    assert float(variable(fppd, "Ran")) == 1, f"the command ran {variable(fppd, 'Ran')} times"
