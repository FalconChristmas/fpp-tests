"""The "FPP Scheduler is disabled" warning is for a player: a remote has no
schedule to disable."""

import time


def disabled_warning(fppd):
    return [w for w in fppd.get("/fppd/warnings_full")
            if w.get("message") == "FPP Scheduler is disabled"]


def test_a_disabled_scheduler_warns_on_a_player(fppd):
    """The control for the remote case: with the scheduler disabled a
    player raises warning 19."""
    fppd.settings(DisableScheduler="1", fppMode="player")
    fppd.start()
    fppd.wait_for(lambda: disabled_warning(fppd), timeout=15, what="the scheduler warning")
    assert disabled_warning(fppd)[0].get("id") == 19


def test_a_disabled_scheduler_does_not_warn_on_a_remote(fppd):
    """A remote with DisableScheduler set raises no "Scheduler is disabled"
    warning.

    Regression: 96a42b8ac. The warning was raised in any mode, so a remote
    (which never runs a schedule) showed a warning it could do nothing about."""
    fppd.settings(DisableScheduler="1", fppMode="remote")
    fppd.start()
    time.sleep(8)  # the player case has it up within a couple of seconds
    assert not disabled_warning(fppd), disabled_warning(fppd)
